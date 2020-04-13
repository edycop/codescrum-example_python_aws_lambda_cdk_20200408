import * as cdk from "@aws-cdk/core";
import dynamodb = require("@aws-cdk/aws-dynamodb");
import appsync = require("@aws-cdk/aws-appsync");
import iam = require("@aws-cdk/aws-iam");
import lambda = require("@aws-cdk/aws-lambda");
import apigateway = require("@aws-cdk/aws-apigateway");

export class CdkLambdaStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //  -------------------------  DYNAMO DB  -------------------------
    const tableName = "events";

    const eventsTable = new dynamodb.Table(this, "events", {
      tableName: tableName,
      partitionKey: {
        name: "id",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // NOT recommended for production code
    });

    //  -------------------------  APPSYNC-GRAPHQL  -------------------------
    const eventsGraphQLApi = new appsync.CfnGraphQLApi(this, "eventsApi", {
      name: "eventsApi",
      authenticationType: "API_KEY",
    });

    const AppSyncApiKey = new appsync.CfnApiKey(this, "eventsApiKey", {
      apiId: eventsGraphQLApi.attrApiId,
    });

    const apiSchema = new appsync.CfnGraphQLSchema(this, "eventsSchema", {
      apiId: eventsGraphQLApi.attrApiId,
      definition: `input ${tableName}Input {
        name: String
        topic: String
        date: String
      }
      type ${tableName} {
        id: ID!
        name: String
        topic: String
        date: String
      }
      type Query {
        listEvents: [${tableName}]!
        getEvent(id: ID!): ${tableName}
      }
      type Mutation {
        saveEvent(input: ${tableName}Input!): ${tableName}
        deleteEvent(id: ID!): ${tableName}
      }
      type Schema {
        query: Query
        mutation: Mutation
      }`,
    });

    // Define an AWS policy to allows AppSync access to DynamoDB
    const eventsTableRole = new iam.Role(this, "eventsDynamoDBRole", {
      assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
    });

    eventsTableRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonDynamoDBFullAccess")
    );

    // Connects AppSync to DynamoDB
    const dataSource = new appsync.CfnDataSource(this, "eventsDataSource", {
      apiId: eventsGraphQLApi.attrApiId,
      name: "eventsDataSource",
      type: "AMAZON_DYNAMODB",
      dynamoDbConfig: {
        tableName: eventsTable.tableName,
        awsRegion: this.region,
      },
      serviceRoleArn: eventsTableRole.roleArn,
    });

    const getEventResolver = new appsync.CfnResolver(
      this,
      "GetEventQueryResolver",
      {
        apiId: eventsGraphQLApi.attrApiId,
        typeName: "Query",
        fieldName: "getEvent",
        dataSourceName: dataSource.name,
        requestMappingTemplate: `{
        "version": "2017-02-28",
        "operation": "GetItem",
        "key": {
          "id": $util.dynamodb.toDynamoDBJson($ctx.args.id)
        }
      }`,
        responseMappingTemplate: `$util.toJson($ctx.result)`,
      }
    );
    getEventResolver.addDependsOn(apiSchema);

    const listEventsResolver = new appsync.CfnResolver(
      this,
      "listEventsQueryResolver",
      {
        apiId: eventsGraphQLApi.attrApiId,
        typeName: "Query",
        fieldName: "listEvents",
        dataSourceName: dataSource.name,
        requestMappingTemplate: `{
        "version": "2017-02-28",
        "operation": "Scan"
      }`,
        responseMappingTemplate: `$util.toJson($ctx.result.items)`,
      }
    );
    listEventsResolver.addDependsOn(apiSchema);

    //  -------------------------  LAMBDA FUNCTION  -------------------------
    // Lambda "requests" dependency
    const lambda_requests_layer = new lambda.LayerVersion(
      this,
      "lambda_requests_layer",
      {
        code: lambda.Code.asset("resources/requests.zip"),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_8],
        license: "MIT",
        layerVersionName: "lambda_requests_layer",
        description: "A layer for requests library dependency",
      }
    );

    const proxy_lambda = new lambda.Function(this, "proxy_lambda", {
      functionName: "proxy_lambda",
      runtime: lambda.Runtime.PYTHON_3_8,
      code: lambda.Code.asset("resources"),
      handler: "events_info.handler",
      memorySize: 128,
      environment: {
        APPSYNC_API_KEY: AppSyncApiKey.attrApiKey,
        APPSYNC_API_ENDPOINT_URL: eventsGraphQLApi.attrGraphQlUrl,
      },
      description:
        "Request handler to get information about events. Triggered by API Gateway.",
      layers: [lambda_requests_layer],
    });

    // ------------------------- API GATEWAY -------------------------
    const eventsRestApi = new apigateway.LambdaRestApi(
      this,
      "events_rest_api",
      {
        proxy: false,
        handler: proxy_lambda,
        restApiName: "events_rest_api",
        description: "Codescrum events REST API",
      }
    );

    // Default integrations response
    const badRequestResponse: apigateway.IntegrationResponse = {
      statusCode: "400",
    };

    const internalServerResponse: apigateway.IntegrationResponse = {
      statusCode: "500",
    };

    const okResponse: apigateway.IntegrationResponse = { statusCode: "200" };

    const integrationResponses = [
      badRequestResponse,
      internalServerResponse,
      okResponse,
    ];

    // Integrate API Gateway with lambda functions: proxy_lambda(graphql/)
    const events_integration = new apigateway.LambdaIntegration(proxy_lambda, {
      integrationResponses: integrationResponses,
    });

    // Add a resource or endpoint to interact with events data, we called "graphql"
    const events_resource = eventsRestApi.root.addResource("graphql");

    // Adding Methods integrations to the API Gateway
    events_resource.addMethod("GET", events_integration);

    //
  }
}
