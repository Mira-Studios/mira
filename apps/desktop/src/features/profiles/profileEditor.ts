import type { Profile } from './useProfiles';

export const PROFILE_EDITOR_EVENT = 'mira:profile-editor';
export type ProfileEditorRequest = { requestId: string; profile?: Profile };
export function openProfileEditor(profile?: Profile) {
  window.dispatchEvent(
    new CustomEvent<ProfileEditorRequest>(PROFILE_EDITOR_EVENT, {
      detail: { requestId: crypto.randomUUID(), profile },
    }),
  );
}
