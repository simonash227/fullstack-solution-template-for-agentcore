#!/usr/bin/env node
import * as cdk from "aws-cdk-lib"
import { FastMainStack } from "../lib/fast-main-stack"
import { ConfigManager } from "../lib/utils/config-manager"

const app = new cdk.App()

// Load client config from CDK context if provided:
//   cdk deploy -c client-config=../../config/clients/smithlaw/client-config.json
const clientConfigFile = app.node.tryGetContext("client-config") as string | undefined

// Load configuration using ConfigManager
const configManager = new ConfigManager("config.yaml", clientConfigFile || undefined)

// Initial props consist of configuration parameters
const props = configManager.getProps()

// Deploy the new Amplify-based stack that solves the circular dependency
const amplifyStack = new FastMainStack(app, props.stack_name_base, {
  config: props,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION
  },
})

app.synth()
