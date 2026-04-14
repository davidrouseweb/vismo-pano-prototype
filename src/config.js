// ================================================================
// CONFIGURATION — tweak these values to prototype ideas
// ================================================================
export const CONFIG = {
  // --- Transition (prototyping area #1) ---
  animateTransitions: true,
  transitionDuration: 800, // ms

  // --- Disc styling (prototyping area #2) ---
  discRadius: 0.35,
  discRingWidth: 0.08, // border thickness (inner radius = discRadius - discRingWidth)
  discSegments: 48,
  discColor: 0xffffff,
  discOutlineColor: 0x000000,
  discOutlineOpacity: 0.2, // subtle dark outline
  discOpacity: 0.3,
  discHoverOpacity: 0.8,
  discSinkY: 2, // how far below pano centre the discs sit
  discPulse: true, // subtle pulse animation on discs
  discAutoHide: false, // when true, discs hidden until click, then fade out
  discAutoHideDelay: 3000, // ms before discs start fading after click
  discFadeDuration: 1000, // ms for fade-out animation

  // --- Sphere ---
  sphereRadius: 20,
  sphereWidthSegments: 128,
  sphereHeightSegments: 64,
  textureOffsetX: 0.5, // Trimble: 0.5, Leica: 0.75

  // --- Pano camera ---
  fov: 75,
  rotateSpeed: -0.3,
  zoomMin: 0.5,
  zoomMax: 5,
  smoothTime: 0.1,
};
