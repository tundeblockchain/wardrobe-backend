/**
 * Writes a local cdk.json from the committed example.
 *
 * cdk.json is gitignored so local/project IDs stay off the repo.
 * CI/CodeBuild always regenerates it from env vars so the pipeline
 * can synth and deploy without a committed cdk.json.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const examplePath = path.join(root, 'cdk.json.example');
const destPath = path.join(root, 'cdk.json');
const isCi = Boolean(process.env.CI || process.env.CODEBUILD_BUILD_ID);

if (!fs.existsSync(examplePath)) {
  throw new Error('cdk.json.example is missing.');
}

if (fs.existsSync(destPath) && !isCi) {
  process.stdout.write('Using existing local cdk.json\n');
  process.exit(0);
}

const template = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
template.context = template.context ?? {};

const envToContext = {
  STAGE: 'stage',
  GITHUB_OWNER: 'githubOwner',
  GITHUB_REPO: 'githubRepo',
  GITHUB_BRANCH: 'githubBranch',
  CODESTAR_CONNECTION_ARN: 'connectionArn',
};

for (const [envName, contextKey] of Object.entries(envToContext)) {
  const value = process.env[envName];
  if (value) {
    template.context[contextKey] = value;
  }
}

fs.writeFileSync(destPath, `${JSON.stringify(template, null, 2)}\n`);
process.stdout.write(`Wrote ${destPath} from cdk.json.example\n`);
