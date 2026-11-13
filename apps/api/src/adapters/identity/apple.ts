import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { unauthorized } from "../../domain/errors.ts";
import type { IdentityVerifier, VerifiedIdentity } from "../../ports/identity.ts";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS = new URL("https://appleid.apple.com/auth/keys");

/**
 * Apple identity token 검증 (ADR-0010).
 *
 * - 서명: Apple JWKS (원격, 캐시)
 * - iss: https://appleid.apple.com
 * - aud: APPLE_CLIENT_IDS (iOS bundle id, 웹 Service ID)
 * - nonce: 토큰에 있으면 요청 nonce 의 SHA-256 과 일치해야 한다
 *
 * 토큰 교환(client secret)이 필요 없는 네이티브 로그인 경로만 다룬다.
 */
export class AppleIdentityVerifier implements IdentityVerifier {
  private readonly clientIds: string[];
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(clientIds: string[]) {
    this.clientIds = clientIds;
    this.jwks = createRemoteJWKSet(APPLE_JWKS);
  }

  async verify(identityToken: string, nonce?: string): Promise<VerifiedIdentity> {
    if (this.clientIds.length === 0) {
      throw unauthorized("Apple client id 가 설정되지 않았습니다.");
    }

    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(identityToken, this.jwks, {
        issuer: APPLE_ISSUER,
        audience: this.clientIds,
        algorithms: ["RS256"],
      });
      payload = result.payload as Record<string, unknown>;
    } catch (err) {
      throw unauthorized(
        `Apple identity token 검증에 실패했습니다: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const subject = payload.sub;
    if (typeof subject !== "string" || subject.length === 0) {
      throw unauthorized("Apple identity token 에 sub 이 없습니다.");
    }

    const tokenNonce = payload.nonce;
    if (typeof tokenNonce === "string" && tokenNonce.length > 0) {
      if (!nonce) throw unauthorized("nonce 가 필요합니다.");
      const hashed = createHash("sha256").update(nonce).digest("hex");
      if (tokenNonce !== hashed && tokenNonce !== nonce) {
        throw unauthorized("nonce 가 일치하지 않습니다.");
      }
    }

    return {
      subject: `apple:${subject}`,
      email: typeof payload.email === "string" ? payload.email : null,
    };
  }
}

/** `APPLE_CLIENT_IDS` 가 있으면 실제 검증기를 만든다. 없으면 null(엔드포인트 503). */
export function createIdentityVerifierFromEnv(
  raw = process.env.APPLE_CLIENT_IDS,
): AppleIdentityVerifier | null {
  if (!raw) return null;
  const ids = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (ids.length === 0) return null;
  return new AppleIdentityVerifier(ids);
}
