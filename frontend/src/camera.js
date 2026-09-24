export async function startCam(video) {
  const s = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
  video.srcObject = s; await video.play(); return s;
}
export const stopCam = s => s && s.getTracks().forEach(t => t.stop());
export function snap(video) {
  const c = document.createElement('canvas'); c.width = 480; c.height = 360;
  c.getContext('2d').drawImage(video, 0, 0, 480, 360);
  return c.toDataURL('image/jpeg', 0.85);
}
