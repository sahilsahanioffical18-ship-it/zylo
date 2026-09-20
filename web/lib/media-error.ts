export function mediaErrorMessage(err: unknown, productName: string): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError') return 'Camera and microphone are blocked. Allow them in your browser’s site settings, then reload.';
  if (name === 'NotFoundError') return 'No camera or microphone found. You can still join with them off.';
  if (name === 'NotReadableError') return 'Your camera or microphone is in use by another app.';
  return `This browser can’t use a camera on this page. Open ${productName} over HTTPS or on localhost.`;
}
