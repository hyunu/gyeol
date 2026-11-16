import type { Person } from "../api/client.ts";

interface SidebarProps {
  query: string;
  onQueryChange(value: string): void;
  people: Person[];
  peopleState: "loading" | "ready" | "error";
  activePersonId: string | null;
  onPersonChange(personId: string | null): void;
  onRetryPeople(): void;
  signedIn: boolean;
}

function SearchIcon() {
  return (
    <svg
      className="field__icon"
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" strokeLinecap="square" />
    </svg>
  );
}

export function Sidebar({
  query,
  onQueryChange,
  people,
  peopleState,
  activePersonId,
  onPersonChange,
  onRetryPeople,
  signedIn,
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="찾아보기">
      <div className="field">
        <label className="field__label" htmlFor="search">
          검색
        </label>
        <div className="field__control">
          <SearchIcon />
          <input
            id="search"
            className="field__input"
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="장소, 대화 내용"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <p className="field__hint">대화 본문과 요약에서 찾습니다.</p>
      </div>

      <section className="people" aria-labelledby="people-heading">
        <div className="rail-heading">
          <h2 className="people__heading" id="people-heading">
            사람
          </h2>
          <span className="rail-heading__count" aria-hidden="true">
            {peopleState === "ready" && people.length > 0
              ? String(people.length).padStart(2, "0")
              : "—"}
          </span>
        </div>

        {peopleState === "loading" && <p className="muted">불러오는 중…</p>}

        {peopleState === "error" && (
          <div className="inline-error">
            <p>사람 목록을 불러오지 못했습니다.</p>
            <button className="text-button" type="button" onClick={onRetryPeople}>
              다시 시도
            </button>
          </div>
        )}

        {peopleState === "ready" && people.length === 0 && (
          <p className="muted">아직 식별된 사람이 없습니다.</p>
        )}

        {peopleState === "ready" && people.length > 0 && (
          <ul className="people__list">
            <li>
              <button
                type="button"
                className="person"
                aria-pressed={activePersonId === null}
                onClick={() => onPersonChange(null)}
              >
                <span className="person__index" aria-hidden="true">
                  00
                </span>
                <span className="person__name">모두</span>
              </button>
            </li>
            {people.map((person, index) => (
              <li key={person.id}>
                <button
                  type="button"
                  className="person"
                  aria-pressed={activePersonId === person.id}
                  onClick={() => onPersonChange(person.id)}
                >
                  <span className="person__index" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="person__name">{person.displayName}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="sidebar__note">
        {signedIn
          ? "Apple 로그인 세션으로 연결되어 있습니다. 기록은 이 계정에만 속합니다."
          : "로컬 임시 인증으로 연결되어 있습니다. 웹 로그인은 Apple Service ID 설정 후 사용할 수 있습니다."}
      </p>
    </aside>
  );
}
