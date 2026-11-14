export interface BrowserWindowObservation {
  process: string;
  windowTitle: string;
}

export interface BrowserNavigationObservation {
  processMatches: boolean;
  titleChanged: boolean;
  observed: boolean;
}

/**
 * Detects a visible browser navigation signal without treating it as proof that
 * search results loaded. A title change is only an observation; page content and
 * the exact submitted query still require stronger browser-specific evidence.
 */
export function assessBrowserNavigation(
  before: BrowserWindowObservation | undefined,
  after: BrowserWindowObservation | undefined,
  expectedProcess: string,
): BrowserNavigationObservation {
  const normalize = (value: string) => value.trim().replace(/\.exe$/i, '').toLowerCase();
  const processMatches = Boolean(
    before && after &&
    normalize(before.process) === normalize(expectedProcess) &&
    normalize(after.process) === normalize(expectedProcess),
  );
  const titleChanged = Boolean(
    before && after &&
    before.windowTitle.trim() &&
    after.windowTitle.trim() &&
    before.windowTitle.trim() !== after.windowTitle.trim(),
  );
  return {
    processMatches,
    titleChanged,
    observed: processMatches && titleChanged,
  };
}
