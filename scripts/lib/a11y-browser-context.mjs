export function createA11yBrowserContextOptions(profile) {
  return {
    colorScheme: "light",
    hasTouch: Boolean(profile.isMobile),
    isMobile: Boolean(profile.isMobile),
    reducedMotion: "reduce",
    viewport: { height: profile.height, width: profile.width },
  };
}
