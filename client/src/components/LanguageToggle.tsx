import { memo } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { LOCALES, LOCALE_LABELS } from '@/i18n/messages';

/**
 * Two locales means a segmented control beats a dropdown: one click to switch,
 * and the alternative is always visible.
 */
export const LanguageToggle = memo(function LanguageToggle({
  className = '',
}: {
  className?: string;
}) {
  const { locale, setLocale } = useI18n();

  return (
    <div
      className={`inline-flex items-center rounded-lg border border-ink-800 bg-ink-900 p-0.5 ${className}`}
      role="group"
      aria-label="Language"
    >
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => setLocale(option)}
          aria-pressed={locale === option}
          title={LOCALE_LABELS[option]}
          className={`rounded-md px-2.5 py-1 text-xs font-medium uppercase transition-colors ${
            locale === option
              ? 'bg-ink-750 text-chalk-50'
              : 'text-chalk-600 hover:text-chalk-200'
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
});
