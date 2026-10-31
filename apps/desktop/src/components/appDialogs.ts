import { electron } from '../electronBridge';

type DialogOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  defaultValue?: string;
};
type DialogAnswer = { accepted: boolean; value?: string };

async function showDialog(
  kind: 'alert' | 'confirm' | 'prompt',
  options: DialogOptions,
): Promise<DialogAnswer> {
  if (!electron?.ipcRenderer) return { accepted: false };
  return electron.ipcRenderer
    .invoke<DialogAnswer>('app-dialog-request', { ...options, kind })
    .catch(() => ({ accepted: false }));
}

export async function confirmDialog(options: DialogOptions): Promise<boolean> {
  return (await showDialog('confirm', options)).accepted;
}

export async function alertDialog(options: DialogOptions): Promise<void> {
  await showDialog('alert', options);
}

export async function promptDialog(options: DialogOptions): Promise<string | null> {
  const answer = await showDialog('prompt', options);
  return answer.accepted ? (answer.value ?? '') : null;
}
