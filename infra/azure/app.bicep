// Demeisen CRM on Azure (step 6): the CRM web app (page + API) and its jobs, in the shared Container Apps environment.
// Holds no data: the database is the existing demeisen-crm-mysql server, reached over its private link.
// Run by an Owner from Cloud Shell after GitHub has built the first image (deploy-azure.yml pushes demeisen-crm:latest);
// afterwards GitHub only swaps the image on each merge. Re-running this is safe: it uses the latest image.
//   az deployment group create -g Non_Inv -f app.bicep -p keyVaultName=<demeisen-kv-xxxxxx>
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param keyVaultName string
param imageTag string = 'latest'
param basePath string = '/crm/'
// Sign-in stays on the Demeisen Cognito pool for now (public settings, not secrets).
param cognitoIssuer string = 'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_o84PDILyl'
param cognitoClientId string = '1egdssvk0dm7ibjpunkgke0hog'
param authDomain string = 'demeisen-crm-poc.auth.eu-west-2.amazoncognito.com'
@description('Front Door check value; empty until the front door exists (step 7).')
@secure()
param originVerify string = ''

var sfx = take(uniqueString(resourceGroup().id), 8)
var tags = { system: 'demeisen-v2', app: 'crm', managedBy: 'crm/infra/azure/app.bicep' }
var image = '${acr.properties.loginServer}/demeisen-crm:${imageTag}'

resource env 'Microsoft.App/managedEnvironments@2024-03-01' existing = { name: 'demeisen-v2-env' }
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: 'demeisenv2${sfx}' }
resource store 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: 'demeisenv2${sfx}' }
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: keyVaultName }
resource appId 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: 'demeisen-v2-crm' }
resource deployId 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = { name: 'demeisen-v2-deploy-crm' }

// ---------- Backups container: only the CRM identity may write ----------
resource blobSvc 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = { parent: store, name: 'default' }
resource backups 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = { parent: blobSvc, name: 'crm-backups' }
var blobContrib = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
resource backupWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(backups.id, appId.id, blobContrib)
  scope: backups
  properties: { roleDefinitionId: blobContrib, principalId: appId.properties.principalId, principalType: 'ServicePrincipal' }
}

// ---------- Settings shared by the app and its jobs ----------
var kvUri = kv.properties.vaultUri
var registries = [{ server: acr.properties.loginServer, identity: appId.id }]
var commonEnv = [
  { name: 'DB_HOST', value: 'demeisen-crm-mysql.mysql.database.azure.com' }
  { name: 'DB_USER', value: 'crm_app' }
  { name: 'DB_PASSWORD', secretRef: 'db-password' }
  { name: 'AZURE_CLIENT_ID', value: appId.properties.clientId }
  { name: 'AZURE_STORAGE_ACCOUNT', value: store.name }
  { name: 'BASE_PATH', value: basePath }
]
var appSecrets = concat([{ name: 'db-password', keyVaultUrl: '${kvUri}secrets/mysql-crm-app', identity: appId.id }],
  empty(originVerify) ? [] : [{ name: 'origin-verify', value: originVerify }])

// ---------- Web app: page + API ----------
resource web 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'demeisen-v2-crm'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appId.id}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: { external: true, targetPort: 8080, transport: 'auto', allowInsecure: false }
      registries: registries
      secrets: appSecrets
    }
    template: {
      containers: [{
        name: 'crm'
        image: image
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: concat(commonEnv, [
          { name: 'COGNITO_ISSUER', value: cognitoIssuer }
          { name: 'COGNITO_CLIENT_ID', value: cognitoClientId }
          { name: 'AUTH_DOMAIN', value: authDomain }
        ], empty(originVerify) ? [] : [{ name: 'ORIGIN_VERIFY', secretRef: 'origin-verify' }])
        probes: [{ type: 'Liveness', httpGet: { path: '/healthz', port: 8080 }, periodSeconds: 30 }]
      }]
      scale: { minReplicas: 0, maxReplicas: 2 }
    }
  }
}

// ---------- Jobs: migrations (run by each GitHub deploy) and the nightly backup ----------
resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: 'demeisen-v2-crm-migrate'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appId.id}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      replicaTimeout: 600
      replicaRetryLimit: 0
      registries: registries
      secrets: [
        { name: 'db-password', keyVaultUrl: '${kvUri}secrets/mysql-crm-app', identity: appId.id }
        { name: 'db-migrator-password', keyVaultUrl: '${kvUri}secrets/mysql-crm-migrator', identity: appId.id }
      ]
    }
    template: {
      containers: [{
        name: 'migrate'
        image: image
        command: ['node', 'src/job.mjs', 'migrate']
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: concat(commonEnv, [{ name: 'DB_MIGRATOR_PASSWORD', secretRef: 'db-migrator-password' }])
      }]
    }
  }
}

resource backup 'Microsoft.App/jobs@2024-03-01' = {
  name: 'demeisen-v2-crm-backup'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${appId.id}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: { cronExpression: '17 2 * * *', parallelism: 1, replicaCompletionCount: 1 }   // 02:17 UTC nightly
      replicaTimeout: 900
      replicaRetryLimit: 1
      registries: registries
      secrets: [{ name: 'db-password', keyVaultUrl: '${kvUri}secrets/mysql-crm-app', identity: appId.id }]
    }
    template: {
      containers: [{
        name: 'backup'
        image: image
        command: ['node', 'src/job.mjs', 'backup']
        resources: { cpu: json('0.5'), memory: '1Gi' }
        env: commonEnv
      }]
    }
  }
}

// ---------- GitHub deploy identity: may update only these three, and use the environment ----------
var contributor = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
resource deployWeb 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(web.id, deployId.id, contributor)
  scope: web
  properties: { roleDefinitionId: contributor, principalId: deployId.properties.principalId, principalType: 'ServicePrincipal' }
}
resource deployMigrate 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(migrate.id, deployId.id, contributor)
  scope: migrate
  properties: { roleDefinitionId: contributor, principalId: deployId.properties.principalId, principalType: 'ServicePrincipal' }
}
resource deployBackup 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(backup.id, deployId.id, contributor)
  scope: backup
  properties: { roleDefinitionId: contributor, principalId: deployId.properties.principalId, principalType: 'ServicePrincipal' }
}
resource envJoin 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'demeisen-v2-aca-environment-user')
  properties: {
    roleName: 'Demeisen v2 Container Apps environment user (${resourceGroup().name})'
    description: 'Read the Demeisen v2 Container Apps environment and place apps in it. Nothing else.'
    type: 'CustomRole'
    assignableScopes: [resourceGroup().id]
    permissions: [{ actions: ['Microsoft.App/managedEnvironments/read', 'Microsoft.App/managedEnvironments/join/action'] }]
  }
}
resource deployEnv 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(env.id, deployId.id, envJoin.id)
  scope: env
  properties: { roleDefinitionId: envJoin.id, principalId: deployId.properties.principalId, principalType: 'ServicePrincipal' }
}

output url string = 'https://${web.properties.configuration.ingress.fqdn}${basePath}'
