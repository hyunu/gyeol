import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  clearAuth,
  getConversation,
  listConversations,
  listPersons,
  signInWithApple,
  signOut,
  startLocalDemo,
  storedAuthUser,
  updateActionItem,
  type AuthUser,
  type ConversationDetail,
  type ConversationSummary,
  type Person,
} from "./api/client.ts";
import { appleClientId, signInWithAppleJs } from "./lib/apple.ts";
import { Sidebar } from "./components/Sidebar.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { Detail } from "./components/Detail.tsx";

type ListState = "loading" | "ready" | "error";
type DetailState = "idle" | "loading" | "ready" | "error";

interface UrlState {
  q: string;
  person: string | null;
  id: string | null;
}

function readUrl(): UrlState {
  const params = new URLSearchParams(window.location.search);
  return {
    q: params.get("q") ?? "",
    person: params.get("person"),
    id: params.get("id"),
  };
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "알 수 없는 오류가 발생했습니다.";
}

/** 모바일에서는 목록과 상세를 한 화면씩 보여 준다. */
function isWideViewport(): boolean {
  return window.matchMedia("(min-width: 961px)").matches;
}

function loginErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "error" in error) {
    const code = (error as { error?: unknown }).error;
    if (code === "popup_closed_by_user") return "로그인 창이 닫혔습니다.";
    if (typeof code === "string") return `Apple 로그인에 실패했습니다. (${code})`;
  }
  if (error instanceof Error) return error.message;
  return "로그인에 실패했습니다.";
}

interface LoginScreenProps {
  appleEnabled: boolean;
  onSignedIn(user: AuthUser): void;
  onLocalDemo(): void;
}

function LoginScreen({ appleEnabled, onSignedIn, onLocalDemo }: LoginScreenProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApple = async () => {
    setBusy(true);
    setError(null);
    try {
      const credential = await signInWithAppleJs();
      const user = await signInWithApple(credential.identityToken, credential.displayName);
      onSignedIn(user);
    } catch (err) {
      console.error(err);
      setError(loginErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login__panel">
        <p className="login__eyebrow">결</p>
        <h1 className="login__title">목소리로 남긴 하루의 기록</h1>
        <p className="login__body">
          Apple 계정으로 로그인하면 이 계정의 기록만 안전하게 다시 읽을 수 있습니다.
        </p>

        {appleEnabled ? (
          <button
            className="login__apple"
            type="button"
            onClick={handleApple}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "로그인 중…" : "Apple로 계속하기"}
          </button>
        ) : (
          <p className="login__notice">
            Apple Service ID(<code>VITE_APPLE_CLIENT_ID</code>)가 설정되지 않았습니다.
          </p>
        )}

        {import.meta.env.DEV && (
          <button className="login__demo" type="button" onClick={onLocalDemo} disabled={busy}>
            로컬 데모로 시작 (개발용)
          </button>
        )}

        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

export function App() {
  const appleEnabled = appleClientId() !== null;
  const [user, setUser] = useState<AuthUser | null>(() => storedAuthUser());
  const [loginRequired, setLoginRequired] = useState(
    () => appleEnabled && storedAuthUser() === null,
  );

  const handleSessionExpired = useCallback(() => {
    clearAuth();
    setUser(null);
    setLoginRequired(appleEnabled);
  }, [appleEnabled]);

  const handleLogout = useCallback(() => {
    void signOut().catch(() => undefined);
    setUser(null);
    setLoginRequired(appleEnabled);
  }, [appleEnabled]);

  if (loginRequired) {
    return (
      <LoginScreen
        appleEnabled={appleEnabled}
        onSignedIn={(next) => {
          setUser(next);
          setLoginRequired(false);
        }}
        onLocalDemo={() => {
          setUser(startLocalDemo());
          setLoginRequired(false);
        }}
      />
    );
  }

  return (
    <Dashboard user={user} onLogout={handleLogout} onSessionExpired={handleSessionExpired} />
  );
}

interface DashboardProps {
  user: AuthUser | null;
  onLogout(): void;
  onSessionExpired(): void;
}

function Dashboard({ user, onLogout, onSessionExpired }: DashboardProps) {
  const initial = useRef<UrlState>(readUrl());
  const [query, setQuery] = useState(initial.current.q);
  const debouncedQuery = useDebounced(query, 250);
  const [personId, setPersonId] = useState<string | null>(initial.current.person);
  const [selectedId, setSelectedId] = useState<string | null>(initial.current.id);

  const [people, setPeople] = useState<Person[]>([]);
  const [peopleState, setPeopleState] = useState<"loading" | "ready" | "error">("loading");
  const [peopleRetry, setPeopleRetry] = useState(0);

  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [listState, setListState] = useState<ListState>("loading");
  const [listRefreshing, setListRefreshing] = useState(false);
  const [listRetry, setListRetry] = useState(0);

  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [detailState, setDetailState] = useState<DetailState>(
    initial.current.id ? "loading" : "idle",
  );
  const [detailRetry, setDetailRetry] = useState(0);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const filtered = debouncedQuery.trim() !== "" || personId !== null;

  // 사람 목록
  useEffect(() => {
    const controller = new AbortController();
    setPeopleState("loading");
    listPersons(controller.signal)
      .then((page) => {
        setPeople(page.items);
        setPeopleState("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        console.error(error);
        setPeopleState("error");
      });
    return () => controller.abort();
  }, [peopleRetry, onSessionExpired]);

  // 대화 목록
  useEffect(() => {
    const controller = new AbortController();
    const hasData = items.length > 0;
    if (hasData) setListRefreshing(true);
    else setListState("loading");

    listConversations({
      q: debouncedQuery,
      personId: personId ?? undefined,
      signal: controller.signal,
    })
      .then((page) => {
        setItems(page.items);
        setTotal(page.total);
        setListState("ready");
        setListRefreshing(false);
        setSelectedId((current) => {
          const stillVisible = current && page.items.some((item) => item.id === current);
          if (stillVisible) return current;
          return isWideViewport() ? (page.items[0]?.id ?? null) : null;
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        console.error(error);
        setListState("error");
        setListRefreshing(false);
      });

    return () => controller.abort();
    // items.length 는 "처음 로딩인지" 판단에만 쓰므로 의존성에서 제외한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, personId, listRetry, onSessionExpired]);

  // 대화 상세
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailState("idle");
      return;
    }
    const controller = new AbortController();
    setDetailState("loading");
    setActionError(null);
    getConversation(selectedId, controller.signal)
      .then((value) => {
        setDetail(value);
        setDetailState("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) {
          onSessionExpired();
          return;
        }
        console.error(error);
        setDetailState("error");
      });
    return () => controller.abort();
  }, [selectedId, detailRetry, onSessionExpired]);

  // URL 반영 (뒤로/새로고침이 같은 화면을 복원한다)
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedQuery.trim()) params.set("q", debouncedQuery.trim());
    if (personId) params.set("person", personId);
    if (selectedId) params.set("id", selectedId);
    const search = params.toString();
    window.history.replaceState(null, "", search ? `?${search}` : window.location.pathname);
  }, [debouncedQuery, personId, selectedId]);

  useEffect(() => {
    const title = detail?.title ? `${detail.title} — 결` : "결 — 대화 기록";
    document.title = title;
  }, [detail]);

  const handleClearFilters = useCallback(() => {
    setQuery("");
    setPersonId(null);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedId(null);
    window.scrollTo({ top: 0 });
  }, []);

  // 모바일에서 상세로 들어가면 화면 맨 위부터 읽는다.
  useEffect(() => {
    if (selectedId && !isWideViewport()) window.scrollTo({ top: 0 });
  }, [selectedId]);

  const handleToggleAction = useCallback(
    (item: ConversationDetail["actionItems"][number]) => {
      const nextStatus = item.status === "done" ? "open" : "done";
      setPendingActionId(item.id);
      setActionError(null);
      setDetail((current) =>
        current
          ? {
              ...current,
              actionItems: current.actionItems.map((candidate) =>
                candidate.id === item.id ? { ...candidate, status: nextStatus } : candidate,
              ),
            }
          : current,
      );

      updateActionItem(item.id, nextStatus)
        .then((updated) => {
          setDetail((current) =>
            current
              ? {
                  ...current,
                  actionItems: current.actionItems.map((candidate) =>
                    candidate.id === updated.id ? { ...candidate, status: updated.status } : candidate,
                  ),
                }
              : current,
          );
        })
        .catch((error) => {
          console.error(error);
          if (error instanceof ApiError && error.status === 401) {
            onSessionExpired();
            return;
          }
          setDetail((current) =>
            current
              ? {
                  ...current,
                  actionItems: current.actionItems.map((candidate) =>
                    candidate.id === item.id ? { ...candidate, status: item.status } : candidate,
                  ),
                }
              : current,
          );
          setActionError(`할 일을 바꾸지 못했습니다. ${errorText(error)}`);
        })
        .finally(() => setPendingActionId(null));
    },
    [onSessionExpired],
  );

  return (
    <div className="app">
      <a className="skip-link" href="#timeline-heading">
        기록으로 건너뛰기
      </a>

      <header className="masthead">
        <div className="masthead__brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
          <div className="masthead__wordmark">
            <h1 className="masthead__title">결</h1>
            <p className="masthead__tagline">목소리로 남긴 하루의 기록</p>
          </div>
        </div>

        <div className="masthead__right">
          <div className="meter" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => (
              <i key={index} style={{ animationDelay: `${index * 90}ms` }} />
            ))}
          </div>
          <span className="status">
            <span className="status__dot" aria-hidden="true" />
            {user ? "SESSION" : "LOCAL"}
          </span>
          {user && (
            <>
              <span className="masthead__user">{user.displayName}</span>
              <button className="masthead__logout" type="button" onClick={onLogout}>
                로그아웃
              </button>
            </>
          )}
          <p className="masthead__meta" aria-live="polite">
            {listRefreshing ? "갱신 중…" : `${total}건의 기록`}
          </p>
        </div>
      </header>

      <div className={selectedId ? "layout layout--detail" : "layout"}>
        <Sidebar
          query={query}
          onQueryChange={setQuery}
          people={people}
          peopleState={peopleState}
          activePersonId={personId}
          onPersonChange={setPersonId}
          onRetryPeople={() => setPeopleRetry((value) => value + 1)}
          signedIn={user !== null}
        />

        <Timeline
          state={listState}
          conversations={items}
          total={total}
          selectedId={selectedId}
          filtered={filtered}
          query={debouncedQuery}
          onSelect={setSelectedId}
          onClearFilters={handleClearFilters}
          onRetry={() => setListRetry((value) => value + 1)}
        />

        <Detail
          state={detailState}
          detail={detail}
          onBack={handleBack}
          onRetry={() => setDetailRetry((value) => value + 1)}
          onToggleAction={handleToggleAction}
          pendingActionId={pendingActionId}
          actionError={actionError}
        />
      </div>

      <footer className="footer">
        <p>
          결 · 계약 우선 프로토타입 ·{" "}
          {user ? "Apple 로그인 세션" : "로컬 데모 인증 (개발용)"}
        </p>
      </footer>
    </div>
  );
}
