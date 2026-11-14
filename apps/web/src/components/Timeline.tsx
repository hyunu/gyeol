import type { ConversationSummary } from "../api/client.ts";
import {
  dateHeading,
  dateParts,
  durationLabel,
  relativeLabel,
  timeLabel,
} from "../lib/format.ts";

interface TimelineProps {
  state: "loading" | "ready" | "error";
  conversations: ConversationSummary[];
  total: number;
  selectedId: string | null;
  filtered: boolean;
  query: string;
  onSelect(conversationId: string): void;
  onClearFilters(): void;
  onRetry(): void;
}

function groupByDay(items: ConversationSummary[]) {
  const groups: Array<{ dateKey: string; startedAt: string; items: ConversationSummary[] }> = [];
  for (const item of items) {
    const { dateKey } = dateParts(item.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.dateKey === dateKey) last.items.push(item);
    else groups.push({ dateKey, startedAt: item.startedAt, items: [item] });
  }
  return groups;
}

function ArrowIcon() {
  return (
    <svg
      className="entry__go"
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" strokeLinecap="square" />
    </svg>
  );
}

export function Timeline({
  state,
  conversations,
  total,
  selectedId,
  filtered,
  query,
  onSelect,
  onClearFilters,
  onRetry,
}: TimelineProps) {
  const groups = groupByDay(conversations);

  return (
    <section className="timeline" aria-labelledby="timeline-heading">
      <header className="timeline__head">
        <p className="eyebrow">기록</p>
        <div className="timeline__title-line">
          <h2 id="timeline-heading">대화 타임라인</h2>
          {state === "ready" && <span className="count">{total}건</span>}
        </div>
        <p className="timeline__sub">최근 대화부터 날짜별로 쌓입니다.</p>
      </header>

      {state === "loading" && (
        <div className="timeline__loading" role="status">
          <span className="sr-only">기록을 불러오는 중입니다.</span>
          {[0, 1, 2].map((row) => (
            <div className="entry entry--skeleton" key={row}>
              <span className="skeleton skeleton--meta" />
              <span className="skeleton skeleton--title" />
              <span className="skeleton skeleton--line" />
            </div>
          ))}
        </div>
      )}

      {state === "error" && (
        <div className="panel-error" role="alert">
          <p className="panel-error__title">기록을 불러오지 못했습니다.</p>
          <p className="panel-error__body">연결을 확인한 뒤 다시 시도해 주세요.</p>
          <button className="button" type="button" onClick={onRetry}>
            다시 시도
          </button>
        </div>
      )}

      {state === "ready" && conversations.length === 0 && filtered && (
        <div className="empty">
          <p className="empty__title">
            {query.trim() ? `“${query.trim()}”과 맞는 기록이 없습니다.` : "이 사람의 기록이 아직 없습니다."}
          </p>
          <p className="empty__body">검색어나 사람 필터를 지우면 전체 기록을 볼 수 있습니다.</p>
          <button className="button" type="button" onClick={onClearFilters}>
            필터 지우기
          </button>
        </div>
      )}

      {state === "ready" && conversations.length === 0 && !filtered && (
        <div className="empty">
          <p className="empty__title">아직 기록이 없습니다.</p>
          <p className="empty__body">
            기기에서 녹음이 올라오면 이곳에 날짜별로 쌓입니다. 업로드가 끝나면 분석이 시작됩니다.
          </p>
        </div>
      )}

      {state === "ready" && groups.length > 0 && (
        <ol className="days">
          {groups.map((group) => {
            const { day, month, year, weekday } = dateParts(group.startedAt);
            return (
              <li className="day" key={group.dateKey}>
                <div className="day__margin" aria-hidden="true">
                  <span className="day__number">{day}</span>
                  <span className="day__month">
                    {Number(month)}월 · {weekday}
                  </span>
                  <span className="day__year">{year}</span>
                  <span className="day__spine" />
                </div>

                <div className="day__body">
                  <h3 className="sr-only">{dateHeading(group.startedAt)}</h3>
                  <ul className="entries">
                    {group.items.map((item) => {
                      const selected = item.id === selectedId;
                      const people = item.people.map((person) => person.displayName).join(", ");
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            className="entry"
                            aria-current={selected ? "true" : undefined}
                            onClick={() => onSelect(item.id)}
                          >
                            <span className="entry__top">
                              <span className="entry__time">{timeLabel(item.startedAt)}</span>
                              <span className="entry__relative">
                                {relativeLabel(item.startedAt)}
                              </span>
                            </span>
                            <span className="entry__title">{item.title || "제목 없는 기록"}</span>
                            <span className="entry__summary">
                              {item.summary || "요약이 아직 없습니다."}
                            </span>
                            <span className="entry__meta">
                              <span>{durationLabel(item.startedAt, item.endedAt)}</span>
                              {people && (
                                <>
                                  <span className="entry__dot" aria-hidden="true" />
                                  <span>{people}</span>
                                </>
                              )}
                              <ArrowIcon />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
