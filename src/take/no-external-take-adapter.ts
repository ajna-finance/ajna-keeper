import { ExternalTakeAdapter } from './engine';
import { TakeActionConfig } from './types';

export function createNoExternalTakeAdapter<
  TApprovalContext = unknown,
>(): ExternalTakeAdapter<TakeActionConfig, unknown, TApprovalContext> {
  return {
    kind: 'none',
  };
}
