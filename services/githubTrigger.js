import axios from 'axios';

// Lets the "Capture Now" button in the dashboard manually kick off the
// screenshot GitHub Action immediately, instead of waiting for its 2x/day
// schedule. Requires a GitHub Personal Access Token with the "repo" scope
// (classic) or "Actions: write" (fine-grained), stored in .env as
// GITHUB_TOKEN. GITHUB_REPO should be "owner/repo", e.g. "yourname/vynox-api".
export async function triggerGithubWorkflow() {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_WORKFLOW_FILE } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    throw new Error(
      'Manual trigger not configured — set GITHUB_TOKEN and GITHUB_REPO in .env to enable "Capture Now". Scheduled captures (2x/day) still run regardless.'
    );
  }

  const workflowFile = GITHUB_WORKFLOW_FILE || 'screenshots.yml';
  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`;

  await axios.post(
    url,
    { ref: process.env.GITHUB_BRANCH || 'main' },
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15000,
    }
  );
}
