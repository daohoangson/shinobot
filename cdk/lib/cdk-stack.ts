import { bedrock, pinecone } from "@cdklabs/generative-ai-cdk-constructs";
import {
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps as CdkStackProps,
  Duration,
  CustomResource,
  SecretValue,
} from "aws-cdk-lib";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as cr from "aws-cdk-lib/custom-resources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { join } from "path";

export interface StackProps extends CdkStackProps {
  pineconeApiKey: string;
}

export class CdkStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    { pineconeApiKey, ...props }: StackProps
  ) {
    super(scope, id, props);

    const embeddingsModel =
      bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024;

    const pineconeSecret = new secretsmanager.Secret(this, "pineconeSecret", {
      secretObjectValue: {
        apiKey: SecretValue.unsafePlainText(pineconeApiKey),
      },
    });

    const pineconeCrHandler = new NodejsFunction(this, "pineconeCrHandler", {
      entry: join(__dirname, "../lambda/pineconeCrHandler/index.ts"),
      environment: {
        PINECONE_SECRET_NAME: pineconeSecret.secretName,
      },
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.minutes(1),
    });
    pineconeSecret.grantRead(pineconeCrHandler);

    const pineconeCrProvider = new cr.Provider(this, "pineconeCrProvider", {
      onEventHandler: pineconeCrHandler,
    });

    // has to implement custom resource instead of using something like `pinecone-db-construct@0.10.0`
    // because it was a bit outdated and didn't support `us-east-1` as a serverless region
    // and more importantly, there was no way to obtain the host after creation
    const pineconeIndex = new CustomResource(this, "pineconeIndex", {
      properties: {
        IndexDimension: embeddingsModel.vectorDimensions!,
        IndexName: this.stackName
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, " ")
          .trim()
          .replace(/\s+/, "-"),
        IndexRegion: this.region,
      },
      serviceToken: pineconeCrProvider.serviceToken,
    });

    const knowledgeBase = new bedrock.KnowledgeBase(this, "knowledgeBase", {
      embeddingsModel,
      vectorStore: new pinecone.PineconeVectorStore({
        connectionString: `https://${pineconeIndex.getAttString("host")}`,
        credentialsSecretArn: pineconeSecret.secretArn,
        metadataField: "metadata",
        textField: "text",
      }),
    });

    const docsBucket = new s3.Bucket(this, "docsBucket", {
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const s3DataSource = new bedrock.S3DataSource(this, "s3DataSource", {
      bucket: docsBucket,
      knowledgeBase: knowledgeBase,
    });

    const user = new iam.User(this, "user");
    const accessKey = new iam.AccessKey(this, "accessKey", { user });
    const policy = new iam.Policy(this, "policy", {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "bedrock:AssociateThirdPartyKnowledgeBase",
            "bedrock:ListIngestionJobs",
            "bedrock:Retrieve",
            "bedrock:StartIngestionJob",
          ],
          resources: [knowledgeBase.knowledgeBaseArn],
        }),
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModelWithResponseStream"],
          resources: ["*"],
        }),
      ],
    });
    policy.attachToUser(user);

    new CfnOutput(this, "AwsAccessKeyId", { value: accessKey.accessKeyId });
    new CfnOutput(this, "AwsRegion", { value: this.region });
    new CfnOutput(this, "AwsSecretAccessKey", {
      value: accessKey.secretAccessKey.unsafeUnwrap(),
    });
    new CfnOutput(this, "DataSourceId", {
      value: s3DataSource.dataSourceId,
    });
    new CfnOutput(this, "DocsBucketName", { value: docsBucket.bucketName });
    new CfnOutput(this, "KnowledgeBaseId", {
      value: knowledgeBase.knowledgeBaseId,
    });
  }
}
