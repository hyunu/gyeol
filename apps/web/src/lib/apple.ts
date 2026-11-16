/**
 * Sign in with Apple JS (ADR-0010).
 *
 * Service ID 와 Return URL 이 Apple 개발자 콘솔에 등록돼 있어야 동작한다.
 * `VITE_APPLE_CLIENT_ID` 가 없으면 로그인 화면에서 이 모듈을 호출하지 않는다.
 */

interface AppleAuthorization {
  authorization: {
    id_token: string;
    code: string;
    state?: string;
  };
  user?: {
    name?: { firstName?: string; lastName?: string };
    email?: string;
  };
}

interface AppleAuth {
  init(config: {
    clientId: string;
    scope: string;
    redirectURI: string;
    usePopup: boolean;
  }): void;
  signIn(): Promise<AppleAuthorization>;
}

declare global {
  interface Window {
    AppleID?: { auth: AppleAuth };
  }
}

const SCRIPT_SRC =
  "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";

let scriptPromise: Promise<void> | null = null;
let initialized = false;

export function appleClientId(): string | null {
  const value = import.meta.env.VITE_APPLE_CLIENT_ID as string | undefined;
  return value?.trim() ? value.trim() : null;
}

function loadScript(): Promise<void> {
  if (window.AppleID) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("Apple 로그인 스크립트를 불러오지 못했습니다."));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Apple JS 팝업을 띄우고 identity token(JWT)과 표시 이름(첫 로그인)을 돌려준다. */
export async function signInWithAppleJs(): Promise<{
  identityToken: string;
  displayName?: string;
}> {
  const clientId = appleClientId();
  if (!clientId) throw new Error("VITE_APPLE_CLIENT_ID 가 설정되지 않았습니다.");

  await loadScript();
  const apple = window.AppleID;
  if (!apple) throw new Error("Apple 로그인을 사용할 수 없습니다.");

  if (!initialized) {
    apple.auth.init({
      clientId,
      scope: "name email",
      redirectURI:
        (import.meta.env.VITE_APPLE_REDIRECT_URI as string | undefined) ?? window.location.origin,
      usePopup: true,
    });
    initialized = true;
  }

  const result = await apple.auth.signIn();
  const token = result.authorization?.id_token;
  if (!token) throw new Error("Apple 로그인 응답에 identity token 이 없습니다.");
  return { identityToken: token, displayName: appleDisplayName(result) };
}

/** Apple JS 가 돌려주는 표시 이름(첫 로그인에만 제공). */
function appleDisplayName(result: AppleAuthorization): string | undefined {
  const name = result.user?.name;
  if (!name) return undefined;
  const value = [name.firstName, name.lastName].filter(Boolean).join(" ").trim();
  return value || undefined;
}
