import { useCallback, useEffect, useState } from 'react';

export interface DeviceOption {
  deviceId: string;
  label: string;
}

export interface MediaDeviceState {
  microphones: DeviceOption[];
  speakers: DeviceOption[];
  /** Labels are empty strings until the user has granted mic permission. */
  labelsAvailable: boolean;
  supportsOutputSelection: boolean;
  refresh: () => void;
}

/**
 * Enumerates audio devices and keeps the list current as hardware is plugged
 * in or removed. Deliberately does not request permission itself — that
 * happens when the user turns their mic on, not when they open settings.
 */
export function useMediaDevices(active: boolean): MediaDeviceState {
  const [microphones, setMicrophones] = useState<DeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<DeviceOption[]>([]);
  const [labelsAvailable, setLabelsAvailable] = useState(false);

  const supportsOutputSelection =
    typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  const refresh = useCallback(() => {
    if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') return;

    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const inputs: DeviceOption[] = [];
        const outputs: DeviceOption[] = [];
        let sawLabel = false;

        for (const device of devices) {
          if (device.label) sawLabel = true;
          const option = { deviceId: device.deviceId, label: device.label };
          if (device.kind === 'audioinput') inputs.push(option);
          if (device.kind === 'audiooutput') outputs.push(option);
        }

        setMicrophones(inputs);
        setSpeakers(outputs);
        setLabelsAvailable(sawLabel);
      })
      .catch(() => {
        setMicrophones([]);
        setSpeakers([]);
      });
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();

    const target = navigator.mediaDevices;
    if (!target?.addEventListener) return;

    target.addEventListener('devicechange', refresh);
    return () => target.removeEventListener('devicechange', refresh);
  }, [active, refresh]);

  return { microphones, speakers, labelsAvailable, supportsOutputSelection, refresh };
}
