import { ReadinessError, requireThat } from './readiness-data.mjs';
import { REVIEW_THREADS_QUERY } from './github-review-evidence.mjs';

/** Fixed-host, read-only GitHub client. No redirects, retries, token output, or
 * mutation endpoints. The fetch seam is trusted and only used by local tests.
 */
export function createGitHubReadClient(token, { fetchImpl = fetch } = {}) {
  requireThat(typeof token === 'string' && token.length > 0 && token.length <= 4096
    && !/[\s\u0000-\u001f\u007f]/u.test(token), 'github_credentials_required');
  async function request(endpoint, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetchImpl(`https://api.github.com/${endpoint}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      requireThat(response.ok === true && response.body, 'github_observation_failed');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        requireThat(size <= 1048576, 'github_observation_too_large');
        chunks.push(chunk);
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof ReadinessError) throw error;
      throw new ReadinessError('github_observation_failed');
    } finally { clearTimeout(timer); controller.abort(); }
  }
  return Object.freeze({
    rest(resource) {
      requireThat(typeof resource === 'string'
        && !resource.split('/').some(segment => segment === '.' || segment === '..')
        && /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pulls\/[1-9][0-9]*(?:\/reviews\?per_page=100&page=[1-9][0-9]*)?$/u.test(resource),
      'github_read_scope_refused');
      return request(resource);
    },
    graphql(query, variables) {
      requireThat(query === REVIEW_THREADS_QUERY, 'github_read_scope_refused');
      return request('graphql', { query, variables });
    }
  });
}
