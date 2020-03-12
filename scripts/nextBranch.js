const { execSync } = require('child_process');
const isFirstBranchNewer = require('../utils/isFirstBranchNewer');
const axios = require('axios');

const currentBranch = execSync('git rev-parse --abbrev-ref HEAD')
  .toString()
  .trim();

console.debug('currentBranch', currentBranch);

if (currentBranch === 'develop' || !currentBranch.startsWith('release/')) {
  console.debug('Clean exit');
  return;
}

const currentVersion = currentBranch.slice(currentBranch.indexOf('/') + 1).trim();

const allBranches = execSync(`git branch -r`)
  .toString()
  .split(/\r?\n/);

const allOtherReleaseBranchVersions = allBranches
  .map(branch => branch.slice(branch.indexOf('/') + 1).trim()) // Trim the origin/ prefix
  .filter(branch => branch.startsWith('release/')) // Only include branches that start with release/
  .map(branch => branch.slice(branch.indexOf('/') + 1)) // Trim the release/ prefix
  .filter(version => version !== currentVersion); // Filter out the current branch version

const allOtherTokenizedReleaseBranchVersions = allOtherReleaseBranchVersions.map(version => ({
  version,
  tokens: version.split(/[_\-+.]+/)
}));

const tokenizedCurrentVersion = {
  version: currentVersion,
  tokens: currentVersion.split(/[_\-+.]+/)
};

const [tokenizedNextVersion] = allOtherTokenizedReleaseBranchVersions
  .filter(version => isFirstBranchNewer(version, tokenizedCurrentVersion))
  .sort(isFirstBranchNewer);

let nextBranch = 'develop';
if (tokenizedNextVersion) {
  nextBranch = `release/${tokenizedNextVersion.version}`
}

console.debug('nextBranch', nextBranch);

execSync(`git checkout --track origin/${nextBranch}`);

try {
  execSync(`git merge ${currentBranch}`, { stdio: 'inherit' });
  execSync(`git push origin ${nextBranch}`);
} catch (e) {
  console.debug('Token exists', !!process.env.GH_TOKEN);
  const prBranchName = `feature/merge-conflict-${tokenizedCurrentVersion.version}-to-${tokenizedNextVersion.version}`;
  execSync(`git checkout -b ${prBranchName}`);
  axios.post('https://api.github.com/repos/jrparish/cascading-merge/pulls', {
    title: `chore: merge '${currentBranch}' into ${nextBranch}`,
    head: prBranchName,
    base: nextBranch
  }, {
    headers: {
      Authorization: `token ${process.env.GH_TOKEN}`
    }
  })
  .catch(e => console.error(e));
}

console.debug('Cascade complete');
