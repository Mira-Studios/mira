import { electron } from '../../electronBridge';
import { collectionKey } from './scopeKey';

export function scopedCollectionKey(base: string): string {
  return collectionKey(base, electron?.workspaceId);
}
