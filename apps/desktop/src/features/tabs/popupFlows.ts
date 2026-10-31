import { isExplicitPopupRequest } from '../../../electron/popupPolicy';

function parseUrl(url: string): URL | null {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

const AUTH_PATH_SEGMENT_PATTERN =
  /(?:^|[/?#&=_-])(login|signin|sign-in|oauth|authorize|auth|sso|consent|selectaccount|accountchooser|challenge|saml)(?:$|[/?#&=_-])/i;
const AUTH_HOST_PATTERN =
  /(^|\.)accounts\.google\.com$|(^|\.)appleid\.apple\.com$|(^|\.)login\.live\.com$|(^|\.)login\.microsoftonline\.com$/i;
const AUTH_CALLBACK_PATH_PATTERN =
  /\/(?:oauth\/)?(?:auth\/)?callback(?:[/?#]|$)|\/signin-oidc(?:[/?#]|$)|\/sso\/callback(?:[/?#]|$)|\/oauth\/complete(?:[/?#]|$)|\/auth\/complete(?:[/?#]|$)/i;
const AUTH_GRANT_PATTERN =
  /[?#&](?:code|access_token|id_token|oauth_token|oauth_verifier|session_state)=/i;

export function isLikelyAuthUrl(url: string): boolean {
  const normalized = url.trim();
  if (!normalized) return false;

  const parsed = parseUrl(normalized);
  const host = parsed?.hostname ?? '';

  return AUTH_PATH_SEGMENT_PATTERN.test(normalized) || AUTH_HOST_PATTERN.test(host);
}

export function shouldAllowNativePopupWindow(
  url: string,
  options?: { disposition?: string; frameName?: string; features?: string },
): boolean {
  return !!url.trim() && isExplicitPopupRequest(options ?? {});
}

export function shouldReturnFromAuthPopup(currentUrl: string, initialUrl: string): boolean {
  const normalizedCurrentUrl = currentUrl.trim();
  const normalizedInitialUrl = initialUrl.trim();
  if (!normalizedCurrentUrl || !normalizedInitialUrl) return false;

  if (
    AUTH_GRANT_PATTERN.test(normalizedCurrentUrl)
    || AUTH_CALLBACK_PATH_PATTERN.test(normalizedCurrentUrl)
  ) {
    return true;
  }

  const currentLooksLikeAuth = isLikelyAuthUrl(normalizedCurrentUrl);
  const initialLooksLikeAuth = isLikelyAuthUrl(normalizedInitialUrl);
  if (!initialLooksLikeAuth) return false;

  const currentParsed = parseUrl(normalizedCurrentUrl);
  const initialParsed = parseUrl(normalizedInitialUrl);
  const currentHost = currentParsed?.hostname ?? '';
  const initialHost = initialParsed?.hostname ?? '';

  if (!currentHost || !initialHost) {
    return !currentLooksLikeAuth;
  }

  if (currentHost !== initialHost && !currentLooksLikeAuth) {
    return true;
  }

  return currentHost === initialHost && !currentLooksLikeAuth;
}
