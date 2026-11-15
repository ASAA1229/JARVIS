// JARVIS CI/CD pipeline (Windows Jenkins agent). Windows PowerShell 5.1 and PowerShell 7 compatible helpers live in ci/jenkins.
// Standard stage order: checkout + source verification, agent prerequisites, locked install, SBOM + dependency audit,
// static analysis + build, tests (JUnit), required browser E2E, package + integrity, archive, optional signing,
// optional gated Nexus release. Ordinary new/dev/fix/test builds never publish; releases need main or release/*,
// ENABLE_NEXUS_PUBLISH=true and an explicit input approval.
pipeline {
  agent any
  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
    skipDefaultCheckout(true)
    timeout(time: 90, unit: 'MINUTES')
  }
  environment {
    CI = 'true'
    PROJECT_NAME = 'JARVIS'
    REQUIRE_BUILD_PROVENANCE = 'true'
    ARTIFACT_FILE = 'jarvis-build.tar.gz'
    MANIFEST_FILE = 'jarvis-manifest.json'
    CHECKSUM_FILE = 'jarvis-build.tar.gz.sha256'
    CUSTOMER_RELEASE_REPORT_PATH = 'customer-release-report.json'
    NPM_CONFIG_UPDATE_NOTIFIER = 'false'
    NPM_CONFIG_FUND = 'false'
  }
  parameters {
    booleanParam(name: 'ENABLE_NEXUS_PUBLISH', defaultValue: false, description: 'Nexus publishing is paused; enable only after explicit approval and configuration. Only runs from main or release/* and still asks for approval.')
    booleanParam(name: 'ENABLE_POLICY_SIGNING', defaultValue: false, description: 'Sign manifest-ignore with the configured Ed25519 Jenkins credentials.')
    booleanParam(name: 'TRIGGER_LOCAL_STACK_DEPLOY', defaultValue: false, description: 'After a green build of branch new, trigger the ASAA-Local-Stack job (local development stack only; the job must exist).')
  }
  stages {
    stage('Checkout and source verification') {
      steps {
        deleteDir()
        script {
          def scmVars = checkout scm
          env.GIT_COMMIT = scmVars.GIT_COMMIT
          env.GIT_BRANCH = scmVars.GIT_BRANCH
          env.GIT_URL = scmVars.GIT_URL
        }
        bat 'git --no-pager log -1 --oneline'
        powershell '''
          $ErrorActionPreference = "Stop"
          $head = (git rev-parse HEAD).Trim()
          if ($LASTEXITCODE -ne 0) { throw "git rev-parse failed." }
          if ($head -ne $env:GIT_COMMIT) { throw "Checked-out commit $head does not match the commit Jenkins resolved ($env:GIT_COMMIT)." }
          if (-not (Test-Path package-lock.json -PathType Leaf)) { throw "package-lock.json is missing." }
        '''
      }
    }
    stage('Agent prerequisites') {
      steps {
        bat 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ci\\jenkins\\agent-prereqs.ps1 -Require "node,npm,git,tar,lockfile,workspace" -NodeRange ">=24" -ReportFile .jenkins-temp\\agent-prereqs.json'
      }
    }
    stage('Install locked dependencies') {
      steps {
        bat 'npm ci'
      }
    }
    stage('SBOM and dependency audit') {
      steps {
        // npm sbom has no --output-file option (it prints to stdout), so redirect it and verify the written file.
        bat 'npm sbom --sbom-format=cyclonedx > jarvis-dependencies.cdx.json'
        bat 'node scripts\\sbom-verify.mjs jarvis-dependencies.cdx.json package-lock.json'
        bat 'npm audit --audit-level=moderate'
      }
    }
    stage('Static analysis and build') {
      steps {
        bat 'npm run lint'
        bat 'npm run build'
      }
    }
    stage('Automated tests') {
      steps {
        bat 'npm run test:ci'
      }
      post {
        always {
          junit testResults: 'test-results/junit-*.xml', allowEmptyResults: true
        }
      }
    }
    stage('Release tooling tests (Python)') {
      steps {
        bat 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ci\\jenkins\\agent-prereqs.ps1 -Require "python" -ReportFile .jenkins-temp\\python-prereqs.json'
        powershell '''
          $ErrorActionPreference = "Stop"
          $env:PYTHONDONTWRITEBYTECODE = "1"
          # Prefer a real interpreter; skip Microsoft Store "App execution alias" stubs in WindowsApps.
          $py = (Get-Command python, python3 -All -ErrorAction SilentlyContinue | Where-Object { $_.Source -notlike '*WindowsApps*' } | Select-Object -First 1).Source
          if ($py) { & $py -m unittest discover -s tests -t . } else { & py -3 -m unittest discover -s tests -t . }
          if ($LASTEXITCODE -ne 0) { throw "Python release-tooling tests failed." }
        '''
      }
    }
    stage('Browser E2E (required)') {
      environment {
        PLAYWRIGHT_BROWSERS_PATH = "${env.PLAYWRIGHT_BROWSERS_PATH ?: (env.WORKSPACE + '\\.playwright-browsers')}"
        BROWSER_DIAG_DIR = 'test-results\\browser-smoke'
      }
      steps {
        script {
          // Playwright's own chromium-headless-shell is independent of the Edge install and of the service account profile.
          def rc = bat(returnStatus: true, script: 'npx playwright-core install chromium-headless-shell')
          if (rc != 0) {
            echo "WARNING: could not download the Playwright headless shell (exit ${rc}); the next step still fails the build unless another browser can launch."
          }
        }
        bat 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ci\\jenkins\\agent-prereqs.ps1 -Require "browser" -ReportFile .jenkins-temp\\browser-prereqs.json'
        bat 'npm run test:browser'
      }
      post {
        always {
          archiveArtifacts artifacts: 'test-results/browser-smoke/**,.jenkins-temp/browser-prereqs.json', allowEmptyArchive: true
        }
      }
    }
    stage('Package and verify integrity') {
      steps {
        bat 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ci\\jenkins\\package-release.ps1 -ProjectName JARVIS -Prefix jarvis -OutputDirs dist'
      }
    }
    stage('Archive verified release bundle') {
      steps {
        archiveArtifacts artifacts: 'jarvis-build.tar.gz,jarvis-manifest.json,jarvis-build.tar.gz.sha256,jarvis-manifest-ignore.json,jarvis-manifest-ignore.json.sha256,jarvis-dependencies.cdx.json', fingerprint: true, onlyIfSuccessful: true
      }
    }
    stage('Sign manifest-ignore policy (optional)') {
      when {
        expression { return params.ENABLE_POLICY_SIGNING }
      }
      steps {
        withCredentials([
          string(credentialsId: 'manifest-ignore-private-key', variable: 'MANIFEST_IGNORE_PRIVATE_KEY'),
          string(credentialsId: 'manifest-ignore-public-key', variable: 'MANIFEST_IGNORE_PUBLIC_KEY')
        ]) {
          powershell '''
            $ErrorActionPreference = "Stop"
            if ([string]::IsNullOrWhiteSpace($env:MANIFEST_IGNORE_PRIVATE_KEY) -or
                [string]::IsNullOrWhiteSpace($env:MANIFEST_IGNORE_PUBLIC_KEY)) {
              throw "Policy-signing credentials are missing or empty."
            }
            $privateFileName = "jarvis-policy-private-" + [Guid]::NewGuid().ToString("N") + ".pem"
            $privatePath = Join-Path $env:TEMP $privateFileName
            $publicPath = Join-Path $env:WORKSPACE ".manifest-ignore-public.pem"
            try {
              [IO.File]::WriteAllText($privatePath, $env:MANIFEST_IGNORE_PRIVATE_KEY, [Text.Encoding]::ASCII)
              [IO.File]::WriteAllText($publicPath, $env:MANIFEST_IGNORE_PUBLIC_KEY, [Text.Encoding]::ASCII)
              node scripts/policy-signature.mjs sign "jarvis-manifest-ignore.json" "jarvis-manifest-ignore.sig" $privatePath
              if ($LASTEXITCODE -ne 0) { throw "Manifest-ignore signing failed." }
              node scripts/policy-signature.mjs verify "jarvis-manifest-ignore.json" "jarvis-manifest-ignore.sig" $publicPath
              if ($LASTEXITCODE -ne 0) { throw "Manifest-ignore signature verification failed." }
              node scripts/customer-release-verifier.mjs verify "jarvis-manifest-ignore.json" "jarvis-manifest-ignore.json.sha256" "$env:MANIFEST_FILE" "$env:ARTIFACT_FILE" "-" "jarvis-manifest-ignore.sig" $publicPath
              if ($LASTEXITCODE -ne 0) { throw "Signed customer release verification failed." }
            } finally {
              if ($privatePath) {
                Remove-Item -Force -LiteralPath $privatePath -ErrorAction SilentlyContinue
              }
              $env:MANIFEST_IGNORE_PRIVATE_KEY = $null
              $env:MANIFEST_IGNORE_PUBLIC_KEY = $null
            }
          '''
          archiveArtifacts artifacts: 'jarvis-manifest-ignore.sig', fingerprint: true
        }
      }
    }
    stage('Publish to Nexus (optional, release branches only)') {
      when {
        beforeInput true
        allOf {
          expression { return isReleaseBranch() }
          expression { return params.ENABLE_NEXUS_PUBLISH }
          expression { return (env.NEXUS_RAW_REPOSITORY_URL ?: '').trim().length() > 0 }
        }
      }
      input {
        message 'Publish the verified JARVIS release bundle to Nexus?'
        ok 'Publish'
      }
      steps {
        withCredentials([usernamePassword(credentialsId: 'nexus-credentials', usernameVariable: 'NEXUS_USER', passwordVariable: 'NEXUS_PASSWORD')]) {
          bat 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ci\\jenkins\\publish-nexus.ps1 -ProjectName JARVIS -Prefix jarvis'
        }
      }
    }
  }
  post {
    success {
      echo 'JARVIS pipeline succeeded; artifact checksums and manifest were verified.'
      echo "Release traceability: project=${env.PROJECT_NAME}; build=${env.BUILD_NUMBER}; commit=${env.GIT_COMMIT}; artifact=${env.ARTIFACT_FILE}; manifest=${env.MANIFEST_FILE}; checksum=${env.CHECKSUM_FILE}."
      script {
        if (params.TRIGGER_LOCAL_STACK_DEPLOY && currentBranchName() == 'new') {
          try {
            build job: 'ASAA-Local-Stack', parameters: [string(name: 'ACTION', value: 'DEPLOY')], wait: false
          } catch (err) {
            echo "WARNING: local stack deployment was requested but could not be triggered: ${err.message}"
            currentBuild.result = 'UNSTABLE'
          }
        } else {
          echo 'No deployment was performed.'
        }
      }
    }
    failure {
      echo 'JARVIS pipeline failed. Review the first failing stage; publication is gated behind successful verification.'
    }
    always {
      // Keep the structured customer-verification failure report and agent diagnostics when present.
      archiveArtifacts artifacts: 'customer-release-report.json,.jenkins-temp/agent-prereqs.json', allowEmptyArchive: true
      powershell '''
        Remove-Item -Force (Join-Path $env:WORKSPACE ".manifest-ignore-public.pem") -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force (Join-Path $env:WORKSPACE ".jenkins-temp") -ErrorAction SilentlyContinue
        Remove-Item -Recurse -Force (Join-Path $env:WORKSPACE ".nexus-verify") -ErrorAction SilentlyContinue
      '''
    }
  }
}

def currentBranchName() {
  def branch = env.BRANCH_NAME ?: env.GIT_BRANCH ?: ''
  return branch.replaceFirst('^refs/heads/', '').replaceFirst('^origin/', '')
}

def isReleaseBranch() {
  def branch = currentBranchName()
  return branch == 'main' || branch.startsWith('release/')
}
