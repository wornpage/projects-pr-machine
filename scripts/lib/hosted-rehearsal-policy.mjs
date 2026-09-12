import { captureData, exactKeys, isOid, requireThat } from '../../integrations/codex/projects-pack-delegation/contracts/readiness-data.mjs';

export function hostedRehearsalPolicy(input, confirmation) {
  const policy = captureData(input);
  exactKeys(policy, ['enabled', 'repository', 'repositoryId', 'baseBranch', 'baseOid']);
  requireThat(policy.enabled === true, 'hosted_rehearsal_disabled');
  requireThat(typeof policy.repository === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9-]*\/projects-pr-rehearsal(?:-[A-Za-z0-9-]+)?$/u.test(policy.repository)
    && policy.repository === confirmation && Number.isSafeInteger(policy.repositoryId) && policy.repositoryId > 0
    && policy.baseBranch === 'main' && isOid(policy.baseOid), 'invalid_hosted_rehearsal_policy');
  return policy;
}
export function verifyHostedTarget(policy, repository, marker, baseOid) {
  requireThat(repository?.id === policy.repositoryId && repository.full_name === policy.repository
    && repository.fork === false && repository.archived === false && repository.disabled === false
    && repository.default_branch === policy.baseBranch && repository.permissions?.push === true,
  'hosted_rehearsal_target_mismatch');
  exactKeys(marker, ['kind', 'repositoryId']);
  requireThat(marker.kind === 'projects-pr-disposable-rehearsal' && marker.repositoryId === policy.repositoryId
    && baseOid === policy.baseOid, 'hosted_rehearsal_target_mismatch');
}
