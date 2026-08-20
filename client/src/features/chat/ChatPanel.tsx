import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MAX_CHAT_LENGTH, type ChatMessage, type Participant } from '@shared/protocol';
import { useI18n } from '@/i18n/I18nProvider';
import { CloseIcon, SendIcon } from '@/components/icons';
import { SpeakerStrip } from './SpeakerStrip';

interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  participants: Participant[];
  selfId: string;
  hostId: string;
  onSend: (text: string) => Promise<boolean>;
}

/**
 * Sits below the stage on phones and beside it on desktop.
 *
 * It deliberately never covers the video. Chatting during something you are
 * watching is the whole point, and a full-screen overlay would mean choosing
 * between reading the room and seeing the picture. On mobile it takes a fixed
 * slice of the height and the stage shrinks to fit above it; there is no
 * backdrop, so what is playing stays visible and audible the whole time.
 */
export const ChatPanel = memo(function ChatPanel({
  open,
  onClose,
  messages,
  participants,
  selfId,
  hostId,
  onSend,
}: ChatPanelProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pinnedToBottomRef = useRef(true);

  // Track whether the reader is at the bottom before new messages land, so
  // someone scrolled up reading history is not yanked back down.
  const onScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 60;
  }, []);

  // Layout effect, not effect: scrolling after paint shows a visible jump.
  useLayoutEffect(() => {
    if (!open || !pinnedToBottomRef.current) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text || sending) return;

      setSending(true);
      // Clear immediately: waiting for the round trip makes typing feel laggy,
      // and a rejection surfaces as a toast rather than a stuck input.
      setDraft('');
      pinnedToBottomRef.current = true;
      const ok = await onSend(text);
      setSending(false);
      if (!ok) setDraft(text);
      inputRef.current?.focus();
    },
    [draft, sending, onSend],
  );

  if (!open) return null;

  return (
    <aside
      className="flex h-[42vh] max-h-[26rem] w-full shrink-0 animate-slide-in-bottom flex-col
                 border-t border-ink-800 bg-ink-900
                 lg:h-auto lg:max-h-none lg:w-80 lg:animate-slide-in-right
                 lg:border-l lg:border-t-0"
      aria-label={t('chat.title')}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-ink-800 px-4 py-2.5 lg:py-3">
        <h2 className="shrink-0 text-sm font-medium text-chalk-50">{t('chat.title')}</h2>

        {/* Who is talking, right where you are already looking while typing. */}
        <div className="min-w-0 flex-1">
          <SpeakerStrip participants={participants} selfId={selfId} />
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="rounded-lg p-1.5 text-chalk-400 transition-colors hover:bg-ink-800 hover:text-chalk-50"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </header>

      <div
        ref={listRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
      >
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-4 text-center">
              <p className="text-sm text-chalk-400">{t('chat.empty')}</p>
              <p className="mt-1 text-xs text-chalk-600">{t('chat.notStored')}</p>
            </div>
          ) : (
            messages.map((message, index) => (
              <Bubble
                key={message.id}
                message={message}
                isSelf={message.from === selfId}
                isHost={message.from === hostId}
                // Consecutive messages from one person show the name once.
                showAuthor={messages[index - 1]?.from !== message.from}
              />
            ))
          )}
        </div>

        <form onSubmit={submit} className="shrink-0 border-t border-ink-800 p-3">
          <div className="flex items-center gap-2">
            <label htmlFor="chat-input" className="sr-only">
              {t('chat.placeholder')}
            </label>
            <input
              id="chat-input"
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t('chat.placeholder')}
              maxLength={MAX_CHAT_LENGTH}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm
                         text-chalk-50 placeholder:text-chalk-600 transition-colors
                         focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={draft.trim().length === 0}
              aria-label={t('chat.send')}
              className="btn-primary shrink-0 !px-2.5 !py-2"
            >
              <SendIcon className="h-4 w-4" />
            </button>
          </div>
      </form>
    </aside>
  );
});

const Bubble = memo(function Bubble({
  message,
  isSelf,
  isHost,
  showAuthor,
}: {
  message: ChatMessage;
  isSelf: boolean;
  isHost: boolean;
  showAuthor: boolean;
}) {
  const { t, locale } = useI18n();

  return (
    <div className={isSelf ? 'flex flex-col items-end' : 'flex flex-col items-start'}>
      {showAuthor && (
        <p className="mb-1 flex items-baseline gap-1.5 px-1 text-xs">
          <span className={isHost ? 'text-accent' : 'text-chalk-400'}>
            {isSelf ? t('common.you') : message.name}
          </span>
          <time className="text-chalk-600" dateTime={new Date(message.at).toISOString()}>
            {formatTime(message.at, locale)}
          </time>
        </p>
      )}
      <p
        className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-snug ${
          isSelf
            ? 'rounded-br-sm bg-accent-muted text-chalk-50'
            : 'rounded-bl-sm bg-ink-850 text-chalk-50'
        }`}
        // Long pasted URLs must wrap rather than widen the panel.
        style={{ overflowWrap: 'anywhere' }}
      >
        {message.text}
      </p>
    </div>
  );
});

/**
 * Formatted with the app's locale rather than the browser's, so a Turkish UI
 * shows 22:21 instead of 10:21 PM even on an en-US machine.
 */
function formatTime(at: number, locale: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}
