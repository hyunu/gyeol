const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** 로컬 시간대 기준으로 날짜를 나눈다. 서버는 UTC ISO 로 준다. */
export function dateParts(iso: string): {
  year: string;
  month: string;
  day: string;
  weekday: string;
  dateKey: string;
} {
  const date = new Date(iso);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return {
    year,
    month,
    day,
    weekday: WEEKDAYS[date.getDay()],
    dateKey: `${year}-${month}-${day}`,
  };
}

export function timeLabel(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function dateHeading(iso: string): string {
  const { year, month, day, weekday } = dateParts(iso);
  return `${year}년 ${Number(month)}월 ${Number(day)}일 ${weekday}요일`;
}

export function durationLabel(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
}

export function segmentTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function dueLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const { month, day } = dateParts(iso);
  return `${Number(month)}월 ${Number(day)}일`;
}

/** "3일 전" 같은 상대 표기. 7일이 넘으면 날짜로 돌려준다. */
export function relativeLabel(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  if (days < 7) return `${days}일 전`;
  const { year, month, day } = dateParts(iso);
  const now = new Date();
  return String(now.getFullYear()) === year
    ? `${Number(month)}월 ${Number(day)}일`
    : `${year}.${month}.${day}`;
}
