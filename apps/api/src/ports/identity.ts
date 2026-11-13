/**
 * 신원 제공자 포트 (ADR-0010).
 *
 * 외부 identity token 을 검증하고, 우리 사용자 키로 쓸 subject 를 돌려준다.
 * 실제 구현은 Apple JWKS, 테스트는 Fake verifier 를 쓴다.
 */
export interface VerifiedIdentity {
  /** `apple:<sub>` 처럼 provider prefix 를 포함한다. */
  subject: string;
  email: string | null;
}

export interface IdentityVerifier {
  verify(identityToken: string, nonce?: string): Promise<VerifiedIdentity>;
}
