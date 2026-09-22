'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ConnectionState,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type RemoteAudioTrack,
  type VideoTrack,
} from 'livekit-client';
import { toast } from 'sonner';
import { ApiError, useApi } from '@/lib/api';
import { brand } from '@/lib/brand';
import { mediaErrorMessage } from '@/lib/media-error';
import { screenStartErrorMessage } from '@/lib/screen-share';
import { promote, seen, videoIdentities } from '@/lib/speaker-order';

export type MediaPrefs = { micOn: boolean; camOn: boolean };
export type LiveKitStatus = 'idle' | 'connecting' | 'connected' | 'error';
export type ShareInput = { grant: number; allowed: boolean; onEnded: () => void };

// room.connect() rejections that aren't an ApiError (bad token, LiveKit host down,
// room full) don't expose a discriminator we can trust across server versions, so
// one generic, retry-able message covers all of them.
const CONNECT_ERROR = `Couldn't connect to the video for this ${brand.room}. Check your connection, then try again.`;
// The server took us out (kick, End for all, a released seat, or the webhook
// evicting a seatless join): see the Disconnected listener below for why this
// never auto-retries.
const REMOVED_ERROR = `You’re no longer connected to the video for this ${brand.room}.`;

function connectErrorMessage(err: unknown): string {
  // api.ts already turns every status the token endpoint can return (0 network,
  // 403 seat lost, 503 LiveKit not configured) into a human sentence. Reuse it
  // verbatim instead of re-deriving copy from err.status here.
  if (err instanceof ApiError) return err.message;
  return CONNECT_ERROR;
}

/**
 * Owns the LiveKit `Room` for a meeting: connects, publishes local mic/cam per
 * `prefs`, applies the speaker-view subscription policy, and hands back plain,
 * comparable snapshots so components can stay props-in, no LiveKit imports.
 *
 * Pass `meetingId: null` while there's nothing to join yet — no Room is created.
 */
export function useLiveKitRoom(meetingId: string | null, prefs: MediaPrefs, share: ShareInput) {
  const api = useApi();
  const roomRef = useRef<Room | null>(null);
  const { grant, allowed } = share;

  // Tracks whether the current connection has already used its one automatic
  // reconnect. Lives outside the effect (a ref, not state) because it must
  // survive the effect re-running when `attempt` bumps for that same retry.
  const retriedRef = useRef(false);

  // Pre-join mic/cam is an INITIAL condition, not an invariant to re-impose on
  // every reconnect: seed micOn/camOn from prefsRef exactly once per hook
  // instance. Without this a network blip that triggers the auto-retry (or a
  // manual retry()) would silently flip a self-muted user's mic back on, since
  // every successful connect() would otherwise re-read the pre-join prefs.
  const hasSeededRef = useRef(false);

  const [status, setStatus] = useState<LiveKitStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [videoTracks, setVideoTracks] = useState<Map<string, VideoTrack>>(new Map());
  const [audioTracks, setAudioTracks] = useState<{ sid: string; track: RemoteAudioTrack }[]>([]);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const [micMuted, setMicMuted] = useState<Set<string>>(new Set());
  const [screenTracks, setScreenTracks] = useState<Map<string, VideoTrack>>(new Map());

  // micOn/camOn start false and are only set once the room actually connects
  // (seeded from prefsRef.current there) — never from `prefs` directly, so
  // `prefs` never has to appear in a dependency array.
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);

  // prefsRef is updated by an effect with NO dependency array on purpose: it
  // keeps `prefs` out of the connect effect's deps, which would otherwise tear
  // down and rebuild the whole LiveKit room on every parent re-render.
  const prefsRef = useRef(prefs);
  const shareRef = useRef(share);
  useEffect(() => {
    prefsRef.current = prefs;
    shareRef.current = share;
  });

  useEffect(() => {
    if (!meetingId) return;

    let cancelled = false;
    // Deferred a tick so this reset isn't a synchronous setState-in-effect
    // (matches the async-callback pattern in web/lib/use-meeting.ts).
    Promise.resolve().then(() => {
      if (cancelled) return;
      setStatus('connecting');
      setError(null);
    });

    // adaptiveStream/dynacast are RoomOptions (constructor). autoSubscribe is a
    // RoomConnectOptions, passed to connect() below — putting it here would
    // silently do nothing and we'd subscribe to every participant's video.
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    // Reads shareRef (never share directly) so listeners and cleanup below don't
    // capture a stale closure over a prop from the render that started this effect.
    const endShare = () => shareRef.current.onEnded();

    // Speaker order driving the subscription policy. A plain local, not React
    // state, so it stays cheap; still built only through the pure promote/seen
    // helpers (immutable-by-habit) rather than mutated in place.
    let order: string[] = [];

    function snapshot() {
      // LiveKit mutes a camera publication rather than unpublishing it when the
      // camera is turned off, so the track object (and its last frame) survives —
      // isMuted has to be checked here too, same as the mic path below, or a
      // stopped camera renders as a frozen/black tile instead of falling back to
      // the avatar.
      const video = new Map<string, VideoTrack>();
      const localCam = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (localCam && !localCam.isMuted && localCam.videoTrack) video.set(room.localParticipant.identity, localCam.videoTrack);
      for (const participant of room.remoteParticipants.values()) {
        const pub = participant.getTrackPublication(Track.Source.Camera);
        if (pub && !pub.isMuted && pub.videoTrack) video.set(participant.identity, pub.videoTrack);
      }

      const audio: { sid: string; track: RemoteAudioTrack }[] = [];
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.audioTrackPublications.values()) {
          if (pub.track) audio.push({ sid: pub.trackSid, track: pub.track as RemoteAudioTrack });
        }
      }

      // Absent-or-muted, for local and every remote participant.
      const muted = new Set<string>();
      const localMic = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      if (!localMic || localMic.isMuted) muted.add(room.localParticipant.identity);
      for (const participant of room.remoteParticipants.values()) {
        const pub = participant.getTrackPublication(Track.Source.Microphone);
        if (!pub || pub.isMuted) muted.add(participant.identity);
      }

      // room.activeSpeakers includes the local participant.
      const speakers = new Set(room.activeSpeakers.map((p) => p.identity));

      // The local share is never included here (it's never rendered to the
      // presenter — VideoStage's presenting branch shows a status line instead).
      const screens = new Map<string, VideoTrack>();
      for (const participant of room.remoteParticipants.values()) {
        const pub = participant.getTrackPublication(Track.Source.ScreenShare);
        if (pub && !pub.isMuted && pub.videoTrack) screens.set(participant.identity, pub.videoTrack);
      }

      setVideoTracks(video);
      setAudioTracks(audio);
      setMicMuted(muted);
      setSpeaking(speakers);
      setScreenTracks(screens);
    }

    // Every remote audio publication gets subscribed regardless of video — we
    // hand-roll attachment instead of RoomAudioRenderer, so this is the only
    // thing standing between "can see them" and "can hear them" too.
    function apply() {
      const live = videoIdentities(order, room.remoteParticipants.keys());
      for (const [identity, participant] of room.remoteParticipants) {
        for (const pub of participant.audioTrackPublications.values()) pub.setSubscribed(true);
        // A ZyloLive share is always on — the spec's "five most-recent speakers
        // plus any ZyloLive share"; cameras follow the speaker slots.
        for (const pub of participant.videoTrackPublications.values())
          pub.setSubscribed(pub.source === Track.Source.ScreenShare || live.has(identity));
      }
    }

    // None of these listeners individually check `cancelled` — that's safe,
    // not an oversight: cleanup calls room.removeAllListeners() synchronously
    // before disconnect(), so once a connection is torn down none of them can
    // fire again, stale or otherwise.
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      order = promote(
        order,
        speakers.map((s) => s.identity),
      );
      apply();
      snapshot();
    });
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      order = seen(order, participant.identity);
      apply();
      snapshot();
    });
    room.on(RoomEvent.TrackPublished, (_publication, participant) => {
      order = seen(order, participant.identity);
      apply();
      snapshot();
    });
    room.on(RoomEvent.TrackSubscribed, () => snapshot());
    room.on(RoomEvent.TrackUnsubscribed, () => snapshot());
    room.on(RoomEvent.TrackMuted, (publication, participant) => {
      // host:mute arrives as LiveKit muting our own mic. Mirror it in the toggle, or it
      // would show "on" over a muted track. Unmuting stays the person's own choice
      // (spec default 3): their next toggle goes through setMicrophoneEnabled as usual.
      if (participant === room.localParticipant && publication.source === Track.Source.Microphone) setMicOn(false);
      snapshot();
    });
    room.on(RoomEvent.TrackUnmuted, () => snapshot());
    room.on(RoomEvent.LocalTrackPublished, () => snapshot());
    room.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      // Every way our own share ends lands here: our Stop, the browser's own "Stop
      // sharing" (livekit-client unpublishes on the track's ended event), and LiveKit
      // unpublishing it after the server revoked the permission. Unpublish already
      // stopped the capture, so the browser's indicator is off; tell the server,
      // which ignores a repeat.
      if (publication.source === Track.Source.ScreenShare) endShare();
      snapshot();
    });
    room.on(RoomEvent.TrackUnpublished, () => snapshot());
    // A full reconnect rebuilds our session from the camera/microphone token, so a
    // share cannot survive it: end it now instead of letting livekit-client try to
    // republish it. A resume (SignalReconnecting) keeps the session, its permission
    // and the share, so it is deliberately not handled.
    room.on(RoomEvent.Reconnecting, () => {
      if (!room.localParticipant.getTrackPublication(Track.Source.ScreenShare)) return;
      endShare();
      room.localParticipant.setScreenShareEnabled(false).catch(() => {});
    });
    // apply() (not just snapshot()) so the slot the leaving participant held is
    // handed to the next person in `order` right away, matching
    // ParticipantConnected — otherwise a room past the 5-live-video limit leaves
    // that slot empty until somebody speaks or publishes.
    room.on(RoomEvent.ParticipantDisconnected, () => {
      apply();
      snapshot();
    });

    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!room.canPlaybackAudio) {
        toast.error(`Click to turn on sound for this ${brand.room}.`, {
          id: 'lk-audio',
          duration: Infinity,
          action: { label: 'Turn on sound', onClick: () => room.startAudio() },
        });
      } else {
        toast.dismiss('lk-audio');
      }
    });

    room.on(RoomEvent.Disconnected, (reason) => {
      if (cancelled) return;
      // Our own disconnect() call, and the case where the socket's
      // meeting:replaced screen already owns the tab (retrying here would just
      // fight the new tab for the identity).
      if (reason === DisconnectReason.CLIENT_INITIATED || reason === DisconnectReason.DUPLICATE_IDENTITY) return;
      // Our server took us out: host:kick (removeParticipant), End for all (deleteRoom),
      // a released seat, or the webhook evicting a seatless join. Retrying would fetch a
      // token, get a 403 and flash an error at someone who was just removed — and the
      // server sends the socket's removed/ended screen BEFORE calling LiveKit, so on
      // those paths this listener is normally gone already. Reaching here means the seat
      // went some other way: say so and offer Retry, never auto-retry.
      if (reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED) {
        setStatus('error');
        setError(REMOVED_ERROR);
        return;
      }
      if (!retriedRef.current) {
        retriedRef.current = true;
        setAttempt((n) => n + 1);
      } else {
        setStatus('error');
        setError(CONNECT_ERROR);
      }
    });

    (async () => {
      try {
        const { token, url } = await api<{ token: string; url: string }>(`/meetings/${meetingId}/livekit-token`);
        if (cancelled) return;
        // autoSubscribe: false — subscriptions are decided entirely by apply(),
        // never by LiveKit's default of "subscribe to everything".
        await room.connect(url, token, { autoSubscribe: false });
        if (cancelled) return;
        retriedRef.current = false;
        order = [...room.remoteParticipants.keys()];
        apply();
        snapshot();
        setStatus('connected');
        // Seed mic/cam from the pre-join prefs once, ever — not on every
        // reconnect. After the first connect this is a no-op: micOn/camOn
        // already hold the user's latest in-meeting choice, and the two media
        // effects below reapply that choice to the fresh Room on their own
        // once `status` cycles back to 'connected'.
        if (!hasSeededRef.current) {
          hasSeededRef.current = true;
          setMicOn(prefsRef.current.micOn);
          setCamOn(prefsRef.current.camOn);
        }
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(connectErrorMessage(err));
      }
    })();

    return () => {
      cancelled = true;
      if (room.localParticipant.getTrackPublication(Track.Source.ScreenShare)) endShare(); // listeners are about to go; disconnect() below stops the capture
      room.removeAllListeners();
      room.disconnect().catch(() => {});
      roomRef.current = null;
      setVideoTracks(new Map());
      setAudioTracks([]);
      setSpeaking(new Set());
      setMicMuted(new Set());
      setScreenTracks(new Map());
      // The AudioPlaybackStatusChanged listener above is gone (removeAllListeners
      // just ran), but its toast isn't: without this it survives past Leave onto
      // the dashboard, and its "Turn on sound" button would call startAudio() on
      // this now-disconnected Room.
      toast.dismiss('lk-audio');
    };
  }, [meetingId, attempt, api]);

  // Fresh acquisition at the LiveKit layer, distinct from pre-join (which
  // stopped its own tracks). setMicrophoneEnabled/setCameraEnabled reject on a
  // denied/busy device (confirmed against LocalParticipant's source: they
  // rethrow out of setTrackEnabled/createTracks), so a plain .catch surfaces it.
  useEffect(() => {
    if (status !== 'connected') return;
    const room = roomRef.current;
    if (!room) return;
    let cancelled = false;
    room.localParticipant.setMicrophoneEnabled(micOn).catch((err) => {
      if (cancelled) return;
      toast.error(mediaErrorMessage(err, brand.product, 'room'));
      setMicOn(false);
    });
    return () => {
      cancelled = true;
    };
  }, [status, micOn]);

  useEffect(() => {
    if (status !== 'connected') return;
    const room = roomRef.current;
    if (!room) return;
    let cancelled = false;
    room.localParticipant.setCameraEnabled(camOn).catch((err) => {
      if (cancelled) return;
      toast.error(mediaErrorMessage(err, brand.product, 'room'));
      setCamOn(false);
    });
    return () => {
      cancelled = true;
    };
  }, [status, camOn]);

  // Screen capture starts HERE AND NOWHERE ELSE: when a NEW grant arrives, i.e. when
  // `grant` changes. A counter, not a boolean, is the whole point — a reconnect, a
  // retry or any re-render keeps the same number, so nothing but a fresh
  // screen:granted can ever open the screen picker again. (Phase 3 shipped the
  // camera/mic version of this bug: a reconnect re-applied the pre-join prefs.)
  useEffect(() => {
    if (grant === 0) return;
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) {
      shareRef.current.onEnded(); // granted, but there is no connected room to share into
      return;
    }
    room.localParticipant
      .setScreenShareEnabled(true, { audio: true })
      .then(() => {
        // The lock went away while the picker was open (host stop, policy switch):
        // the publish still won the race, so take it straight down.
        if (!shareRef.current.allowed) room.localParticipant.setScreenShareEnabled(false).catch(() => {});
      })
      .catch((err) => {
        // Cancelled picker, OS refusal, unsupported browser, refused publish.
        // livekit-client has already stopped anything it captured.
        toast.error(screenStartErrorMessage(err, brand.live));
        shareRef.current.onEnded();
      });
  }, [grant]);

  // This effect only ever turns sharing OFF: the server says someone else, or nobody,
  // holds the lock (host stop, policy switch, a new tab took the seat).
  useEffect(() => {
    if (allowed) return;
    roomRef.current?.localParticipant.setScreenShareEnabled(false).catch(() => {});
  }, [allowed]);

  const retry = useCallback(() => {
    retriedRef.current = false;
    setAttempt((n) => n + 1);
  }, []);
  const toggleMic = useCallback(() => setMicOn((v) => !v), []);
  const toggleCam = useCallback(() => setCamOn((v) => !v), []);

  // The ZyloLive button while presenting: tell the server first, so even a share
  // whose picker is still open cannot go live afterwards, then stop locally without
  // waiting on the round trip — a dead socket must never keep the capture running.
  const stopScreenShare = useCallback(() => {
    shareRef.current.onEnded();
    roomRef.current?.localParticipant.setScreenShareEnabled(false).catch(() => {});
  }, []);

  return {
    status,
    error,
    retry,
    videoTracks,
    audioTracks,
    speaking,
    micMuted,
    micOn,
    camOn,
    toggleMic,
    toggleCam,
    screenTracks,
    stopScreenShare,
  };
}
