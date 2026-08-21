import { memo, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useI18n, useT } from '@/i18n/I18nProvider';
import { LOCALES, LOCALE_LABELS } from '@/i18n/messages';
import { Modal } from '@/components/Modal';
import { AvatarPicker } from '@/features/profile/AvatarPicker';
import { useMediaDevices } from '@/hooks/useMediaDevices';
import { formatKeyCode } from '@/features/audio/usePushToTalk';
import { detectHardwareAcceleration } from '@/services/webrtc/capture';
import {
  RESOLUTION_LABELS,
  type AudioSettings,
  type FrameRatePreset,
  type QualitySettings,
  type ResolutionPreset,
} from '@/types/media';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  quality: QualitySettings;
  onQualityChange: (next: QualitySettings) => void;
  audio: AudioSettings;
  onAudioChange: (next: AudioSettings) => void;
  avatar: string | null;
  onAvatarChange: (avatar: string | null) => void;
  selfName: string;
  selfId: string;
  isHost: boolean;
  isSharing: boolean;
  onRegenerateCode: () => void;
  onCloseRoom: () => void;
}

const RESOLUTION_OPTIONS: ResolutionPreset[] = ['auto', '720p', '1080p', '1440p', '2160p'];
const FRAME_RATE_OPTIONS: FrameRatePreset[] = ['auto', 30, 60];

export const SettingsPanel = memo(function SettingsPanel({
  open,
  onClose,
  quality,
  onQualityChange,
  audio,
  onAudioChange,
  avatar,
  onAvatarChange,
  selfName,
  selfId,
  isHost,
  isSharing,
  onRegenerateCode,
  onCloseRoom,
}: SettingsPanelProps) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const devices = useMediaDevices(open);
  const [capturingKey, setCapturingKey] = useState(false);

  // Probing the GPU costs a canvas allocation, so it happens once per session
  // and only if the user actually opens settings.
  const hardwareAccelerated = useMemo(() => (open ? detectHardwareAcceleration() : null), [open]);

  useEffect(() => {
    if (!capturingKey) return;

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape') {
        setCapturingKey(false);
        return;
      }
      onAudioChange({ ...audio, pushToTalkKey: event.code });
      setCapturingKey(false);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturingKey, audio, onAudioChange]);

  return (
    <Modal open={open} onClose={onClose} title={t('settings.title')} labelClose={t('common.close')}>
      <div className="space-y-7">
        {/* -------------------------------------------------------- Profile */}
        <Section title={t('profile.title')}>
          <AvatarPicker
            name={selfName}
            id={selfId}
            avatar={avatar}
            onChange={onAvatarChange}
            size="md"
          />
        </Section>

        {/* ---------------------------------------------------------- Audio */}
        <Section title={t('settings.audio')}>
          <SelectField
            label={t('settings.microphone')}
            value={audio.microphoneId ?? ''}
            onChange={(value) => onAudioChange({ ...audio, microphoneId: value || null })}
            options={[
              { value: '', label: t('settings.defaultDevice') },
              ...devices.microphones.map((device, index) => ({
                value: device.deviceId,
                label: device.label || `${t('settings.microphone')} ${index + 1}`,
              })),
            ]}
          />

          {devices.supportsOutputSelection ? (
            <SelectField
              label={t('settings.speaker')}
              value={audio.speakerId ?? ''}
              onChange={(value) => onAudioChange({ ...audio, speakerId: value || null })}
              options={[
                { value: '', label: t('settings.defaultDevice') },
                ...devices.speakers.map((device, index) => ({
                  value: device.deviceId,
                  label: device.label || `${t('settings.speaker')} ${index + 1}`,
                })),
              ]}
            />
          ) : null}

          {!devices.labelsAvailable && (
            <p className="text-xs text-chalk-600">{t('settings.devicePermission')}</p>
          )}

          <ToggleField
            label={t('settings.pushToTalk')}
            hint={t('settings.pushToTalkHint')}
            checked={audio.pushToTalk}
            onChange={(checked) => onAudioChange({ ...audio, pushToTalk: checked })}
          />

          {audio.pushToTalk && (
            <div className="flex items-center justify-between gap-3 pl-1">
              <span className="text-sm text-chalk-400">{t('settings.shortcut')}</span>
              <button
                type="button"
                onClick={() => setCapturingKey(true)}
                className="min-w-[6rem] rounded-lg border border-ink-700 bg-ink-850 px-3 py-1.5 font-mono text-xs text-chalk-50 transition-colors hover:border-accent"
              >
                {capturingKey ? t('settings.pressKey') : formatKeyCode(audio.pushToTalkKey)}
              </button>
            </div>
          )}
        </Section>

        {/* --------------------------------------------------- Screen share */}
        <Section title={t('settings.screenShare')}>
          <ChoiceField
            label={t('settings.resolution')}
            value={quality.resolution}
            options={RESOLUTION_OPTIONS.map((option) => ({
              value: option,
              label: option === 'auto' ? t('settings.auto') : RESOLUTION_LABELS[option],
            }))}
            onChange={(value) => onQualityChange({ ...quality, resolution: value })}
          />

          <ChoiceField
            label={t('settings.frameRate')}
            value={quality.frameRate}
            options={FRAME_RATE_OPTIONS.map((option) => ({
              value: option,
              label: option === 'auto' ? t('settings.auto') : `${option} FPS`,
            }))}
            onChange={(value) => onQualityChange({ ...quality, frameRate: value })}
          />

          <p className="text-xs text-chalk-600">
            {isSharing ? t('settings.appliedLive') : t('settings.liveOnly')}
          </p>
        </Section>

        {/* ---------------------------------------------------- Performance */}
        <Section title={t('settings.performance')}>
          <ToggleField
            label={t('settings.adaptiveQuality')}
            hint={t('settings.adaptiveQualityHint')}
            checked={quality.adaptive}
            onChange={(checked) => onQualityChange({ ...quality, adaptive: checked })}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-chalk-400">{t('settings.hardwareAcceleration')}</span>
            <span className="text-xs text-chalk-600">
              {hardwareAccelerated === null
                ? '—'
                : hardwareAccelerated
                  ? t('settings.detected')
                  : t('settings.notDetected')}
            </span>
          </div>
        </Section>

        {/* ----------------------------------------------------- Appearance */}
        <Section title={t('settings.appearance')}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-chalk-400">{t('settings.theme')}</span>
            {/* One theme by design: a light mode would fight the video. */}
            <span className="text-xs text-chalk-600">{t('settings.themeDark')}</span>
          </div>
          <ChoiceField
            label={t('settings.language')}
            value={locale}
            options={LOCALES.map((option) => ({ value: option, label: LOCALE_LABELS[option] }))}
            onChange={setLocale}
          />
        </Section>

        {/* ----------------------------------------------------------- Room */}
        {isHost && (
          <Section title={t('settings.room')}>
            <div className="space-y-2">
              <button type="button" onClick={onRegenerateCode} className="btn-secondary w-full">
                {t('settings.regenerateCode')}
              </button>
              <p className="text-xs text-chalk-600">{t('settings.regenerateHint')}</p>
            </div>
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(t('settings.confirmClose'))) onCloseRoom();
                }}
                className="btn-danger w-full"
              >
                {t('settings.closeRoom')}
              </button>
              <p className="text-xs text-chalk-600">{t('settings.closeRoomHint')}</p>
            </div>
          </Section>
        )}
      </div>
    </Modal>
  );
});

/* -------------------------------------------------------------------------- */
/* Field primitives                                                           */
/* -------------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-medium uppercase tracking-wide text-chalk-600">{title}</h3>
      {children}
    </section>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm text-chalk-400">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-chalk-50 transition-colors focus:border-accent focus:outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Segmented control — better than a dropdown for 2-5 short, comparable options. */
function ChoiceField<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm text-chalk-400">{label}</span>
      <div className="flex flex-wrap gap-1 rounded-lg border border-ink-800 bg-ink-850 p-1">
        {options.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={value === option.value}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
              value === option.value
                ? 'bg-ink-700 text-chalk-50'
                : 'text-chalk-600 hover:text-chalk-200'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm text-chalk-200">
          {label}
        </label>
        {hint && <p className="mt-0.5 text-xs text-chalk-600">{hint}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-ink-700'
        }`}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-full bg-ink-950 transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
}
