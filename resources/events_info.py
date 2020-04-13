import json
import os
import logging

from requests import Session

APPSYNC_API_ENDPOINT_URL = os.getenv("APPSYNC_API_ENDPOINT_URL")
APPSYNC_API_KEY = os.getenv("APPSYNC_API_KEY")

LOG = logging.getLogger()
LOG.setLevel(logging.INFO)

session = Session()


def handler(request: dict, _context) -> dict:
    """
    Receive a GET request and send it to AWS AppSync
    """
    response = {}

    if "queryStringParameters" in request and request['queryStringParameters'] != None:
        request_query_parameter = json.loads(
            json.dumps(request["queryStringParameters"]))
        if 'query' in request_query_parameter:
            result = None
            try:
                result = session.request(
                    url=APPSYNC_API_ENDPOINT_URL,
                    method='POST',
                    headers={'x-api-key': APPSYNC_API_KEY},
                    json={'query': request_query_parameter['query']}
                )
            except Exception as e:
                LOG.info(f"Error in request AppSync endpoint: {e}")

            if result:
                response = {"statusCode": 200,
                            "body": json.dumps(result.json()['data'])}
            else:
                response = {"statusCode": 500,
                            "body": json.dumps({"message": "Something was wrong"})}

    response["headers"] = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    }

    return response
