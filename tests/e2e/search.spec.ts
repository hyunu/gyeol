import { expect, test } from "@playwright/test";

/**
 * W-17: 날짜·인물·키워드 검색 E2E.
 * 데이터는 tests/e2e/global-setup.mjs 가 메모리 저장소에 넣는다.
 */

test("타임라인이 날짜별로 보이고 3건이 표시된다", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "대화 타임라인" })).toBeVisible();
  await expect(page.getByText("3건의 기록")).toBeVisible();
  await expect(page.locator(".entry")).toHaveCount(3);

  // 날짜 그룹은 화면에는 크게, 보조기기에는 h3 로 읽힌다.
  await expect(page.locator(".day")).toHaveCount(3);
  await expect(page.locator(".day__number")).toHaveCount(3);
});

test("키워드 검색은 대화 본문에서 찾고, 결과 없음은 필터를 지울 수 있다", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".entry")).toHaveCount(3);

  const search = page.getByLabel("검색");
  await search.fill("북한산");

  await expect(page).toHaveURL(/q=/);
  await expect(page.locator(".entry")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /북한산 등산 계획/ })).toBeVisible();

  await search.fill("존재하지않는단어");
  await expect(page.getByText(/존재하지않는단어.*기록이 없습니다/)).toBeVisible();
  await expect(page.locator(".entry")).toHaveCount(0);

  await page.getByRole("button", { name: "필터 지우기" }).click();
  await expect(page.locator(".entry")).toHaveCount(3);
  await expect(search).toHaveValue("");
});

test("인물 필터와 해제가 동작하고 URL 에 반영된다", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".entry")).toHaveCount(3);

  await page.getByRole("button", { name: "김민수", exact: true }).click();
  await expect(page).toHaveURL(/person=/);
  await expect(page.locator(".entry")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /북한산 등산 계획/ })).toBeVisible();

  await page.getByRole("button", { name: "모두", exact: true }).click();
  await expect(page.locator(".entry")).toHaveCount(3);
});

test("상세를 열면 요약·대화·할 일이 보이고 할 일 상태가 유지된다", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /북한산 등산 계획/ }).click();

  await expect(page).toHaveURL(/id=/);
  await expect(page.getByRole("heading", { level: 1, name: "북한산 등산 계획" })).toBeVisible();
  await expect(page.locator(".detail__summary")).toContainText("주말에 북한산에 오르기로 했다");
  await expect(page.getByText("이번 주말에 북한산 갈래?")).toBeVisible();
  await expect(page.getByText("준비물은 내가 챙길게.")).toBeVisible();

  const toggle = page.getByRole("button", { name: "완료로 표시" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByRole("button", { name: "완료 취소" })).toBeVisible();

  // 새로고침해도 서버 상태가 유지된다.
  await page.reload();
  await expect(page.getByRole("button", { name: "완료 취소" })).toBeVisible();
});

test("상세 URL 로 바로 열 수 있다(딥링크)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /병원 예약과 저녁 약속/ }).click();
  await expect(page).toHaveURL(/id=/);
  const url = page.url();

  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: "병원 예약과 저녁 약속" })).toBeVisible();
  await expect(page.getByText("화요일 오후 두 시로 예약했어.")).toBeVisible();
});

test.describe("모바일", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("목록에서 상세로 들어가고 목록으로 돌아온다", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".entry")).toHaveCount(3);

    await page.getByRole("button", { name: /북한산 등산 계획/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "북한산 등산 계획" })).toBeVisible();
    await expect(page.locator(".timeline")).toBeHidden();

    await page.getByRole("button", { name: "목록으로" }).click();
    await expect(page.locator(".timeline")).toBeVisible();
    await expect(page.locator(".entry")).toHaveCount(3);
  });
});
