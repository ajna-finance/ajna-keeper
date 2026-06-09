export function buildReplayCommand(params) {
  return [
    'npm',
    'run',
    'no-spend-validation',
    '--',
    '--base-fork-block',
    String(params.resolvedForkBlockNumber),
  ];
}

export function buildStateIntegrityArtifact(params) {
  if (!params.dryRunReport || !params.executionReport) {
    return undefined;
  }
  const dryRunBefore = params.dryRunReport.stateArtifact?.auctionBeforeTake;
  const executionBefore =
    params.executionReport.stateArtifact?.auctionBeforeTake;
  const sameCollateral =
    String(dryRunBefore?.collateral ?? '') ===
    String(executionBefore?.collateral ?? '');
  return {
    snapshotRevertedBeforeExecution: true,
    dryRunBroadcastTransactions:
      params.dryRunReport.txArtifact?.transactions?.length ?? 0,
    auctionBeforeDryRun: dryRunBefore ?? null,
    auctionBeforeExecution: executionBefore ?? null,
    auctionCollateralRestoredAfterDryRun: sameCollateral,
    dynamicAuctionFieldsChangedAfterReplay:
      JSON.stringify(dryRunBefore ?? null) !==
      JSON.stringify(executionBefore ?? null),
    dryRunMutatedForkBeforeRevert:
      JSON.stringify(params.dryRunReport.stateArtifact?.auctionAfterTake ?? null) !==
      JSON.stringify(dryRunBefore ?? null),
  };
}
