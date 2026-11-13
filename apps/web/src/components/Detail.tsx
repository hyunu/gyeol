import type { ConversationDetail } from "../api/client.ts";
import {
  dateHeading,
  dueLabel,
  durationLabel,
  segmentTime,
  timeLabel,
} from "../lib/format.ts";

interface DetailProps {
  state: "idle" | "loading" | "ready" | "error";
  detail: ConversationDetail | null;
  onBack(): void;
  onRetry(): void;
  onToggleAction(item: ConversationDetail["actionItems"][number]): void;
  pendingActionId: string | null;
  actionError: string | null;
}

const ENTITY_LABELS: Record<string, string> = {
  person: "사람",
  place: "장소",
  event: "사건",
  appointment: "약속",
  task: "할 일",
  other: "기타",
};

export function Detail({
  state,
  detail,
  onBack,
  onRetry,
  onToggleAction,
  pendingActionId,
  actionError,
}: DetailProps) {
  if (state === "idle") {
    return (
      <section className="detail detail--idle" aria-label="대화 상세">
        <p className="eyebrow">읽기</p>
        <p className="detail__prompt">왼쪽 기록에서 하루를 고르세요.</p>
        <p className="detail__prompt-hint">요약과 대화 전문, 그날의 할 일을 함께 볼 수 있습니다.</p>
      </section>
    );
  }

  if (state === "loading") {
    return (
      <section className="detail" aria-label="대화 상세" role="status">
        <button className="detail__back" type="button" onClick={onBack}>
          목록으로
        </button>
        <span className="sr-only">대화를 불러오는 중입니다.</span>
        <div className="detail__skeleton">
          <span className="skeleton skeleton--meta" />
          <span className="skeleton skeleton--heading" />
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--line" />
        </div>
      </section>
    );
  }

  if (state === "error" || !detail) {
    return (
      <section className="detail" aria-label="대화 상세">
        <button className="detail__back" type="button" onClick={onBack}>
          목록으로
        </button>
        <div className="panel-error" role="alert">
          <p className="panel-error__title">대화를 불러오지 못했습니다.</p>
          <p className="panel-error__body">잠시 뒤 다시 시도해 주세요.</p>
          <button className="button" type="button" onClick={onRetry}>
            다시 시도
          </button>
        </div>
      </section>
    );
  }

  const speakerById = new Map(detail.speakers.map((speaker) => [speaker.id, speaker]));
  const entitiesByKind = new Map<string, string[]>();
  for (const entity of detail.entities) {
    const list = entitiesByKind.get(entity.kind) ?? [];
    if (!list.includes(entity.value)) list.push(entity.value);
    entitiesByKind.set(entity.kind, list);
  }

  return (
    <article className="detail" aria-labelledby="detail-title">
      <button className="detail__back" type="button" onClick={onBack}>
        목록으로
      </button>

      <header className="detail__head">
        <p className="eyebrow">
          {dateHeading(detail.startedAt)} · {timeLabel(detail.startedAt)} ·{" "}
          {durationLabel(detail.startedAt, detail.endedAt)}
        </p>
        <h1 className="detail__title" id="detail-title">
          {detail.title || "제목 없는 기록"}
        </h1>

        {detail.people.length > 0 && (
          <p className="detail__people">
            함께한 사람 <span aria-hidden="true">—</span>{" "}
            {detail.people.map((person) => person.displayName).join(", ")}
          </p>
        )}

        {detail.summary && <p className="detail__summary">{detail.summary}</p>}
        {detail.status === "partial" && (
          <p className="detail__partial">일부 구간은 인식하지 못했습니다. 남은 기록만 보여 줍니다.</p>
        )}
      </header>

      <section className="detail__section" aria-labelledby="transcript-heading">
        <h2 className="section-title" id="transcript-heading">
          대화
        </h2>
        {detail.segments.length === 0 ? (
          <p className="muted">남아 있는 대화 구간이 없습니다.</p>
        ) : (
          <ol className="segments">
            {detail.segments.map((segment) => {
              const speaker = segment.speakerClusterId
                ? speakerById.get(segment.speakerClusterId)
                : undefined;
              const name = speaker?.displayName || speaker?.label || "화자 미상";
              const unknown = !speaker?.displayName;
              return (
                <li className="segment" key={segment.id}>
                  <div className="segment__meta">
                    <span className="segment__time">{segmentTime(segment.startMs)}</span>
                    <span className={unknown ? "segment__speaker segment__speaker--unknown" : "segment__speaker"}>
                      {name}
                    </span>
                  </div>
                  <p className="segment__text">{segment.text}</p>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {entitiesByKind.size > 0 && (
        <section className="detail__section" aria-labelledby="entities-heading">
          <h2 className="section-title" id="entities-heading">
            기억한 것
          </h2>
          <dl className="entities">
            {[...entitiesByKind.entries()].map(([kind, values]) => (
              <div className="entities__row" key={kind}>
                <dt>{ENTITY_LABELS[kind] ?? kind}</dt>
                <dd>{values.join(", ")}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {detail.actionItems.length > 0 && (
        <section className="detail__section" aria-labelledby="actions-heading">
          <h2 className="section-title" id="actions-heading">
            할 일
          </h2>
          {actionError && (
            <p className="inline-error" role="alert">
              {actionError}
            </p>
          )}
          <ul className="actions">
            {detail.actionItems.map((item) => {
              const done = item.status === "done";
              const pending = pendingActionId === item.id;
              const due = dueLabel(item.dueAt);
              return (
                <li className={done ? "action action--done" : "action"} key={item.id}>
                  <button
                    type="button"
                    className="action__toggle"
                    aria-pressed={done}
                    aria-busy={pending || undefined}
                    disabled={pending}
                    onClick={() => onToggleAction(item)}
                  >
                    <span className="action__box" aria-hidden="true" />
                    <span className="action__label">{done ? "완료 취소" : "완료로 표시"}</span>
                  </button>
                  <span className="action__title">{item.title}</span>
                  {due && <span className="action__due">{due}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </article>
  );
}
