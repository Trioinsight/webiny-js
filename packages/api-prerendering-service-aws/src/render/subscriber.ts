import { EventBridgeEvent } from "aws-lambda";
import SqsClient, { SendMessageBatchRequestEntry } from "aws-sdk/clients/sqs";

import {
    Args,
    PrerenderingServiceStorageOperations,
    RenderPagesEvent
} from "@webiny/api-prerendering-service/types";
import { ArgsContext } from "@webiny/handler-args/types";
import { Context, HandlerPlugin as DefaultHandlerPlugin } from "@webiny/handler/types";

export type HandlerArgs = EventBridgeEvent<"RenderPages", RenderPagesEvent | RenderPagesEvent[]>;

export interface HandlerContext extends Context, ArgsContext<HandlerArgs> {
    //
}

export interface HandlerConfig {
    storageOperations: PrerenderingServiceStorageOperations;
    sqsQueueUrl: string;
}

export type HandlerPlugin = DefaultHandlerPlugin<HandlerContext>;

export default (params: HandlerConfig): HandlerPlugin => {
    const { storageOperations } = params;
    const sqsClient = new SqsClient();

    return {
        type: "handler",
        async handle(context) {
            if (context.invocationArgs["detail-type"] !== "RenderPages") {
                return;
            }

            let events = context.invocationArgs.detail;
            if (!Array.isArray(events)) {
                events = [events];
            }

            const toRender = new Map<string, Args>();

            for (const event of events) {
                const namespace = event.configuration?.db?.namespace ?? "";
                if (event.path === "*") {
                    const renders = await storageOperations.listRenders({
                        where: { namespace }
                    });

                    for (const render of renders) {
                        if (render.args) {
                            const args = normalizeArgs(render.args);
                            if (args.path) {
                                toRender.set(args.path, args);
                            }
                        }
                    }
                } else if (event.tag) {
                    const renders = await storageOperations.listRenders({
                        where: {
                            namespace,
                            tag: event.tag
                        }
                    });

                    for (const render of renders) {
                        if (render.args) {
                            const args = normalizeArgs(render.args);
                            if (args.path) {
                                toRender.set(args.path, args);
                            }
                        }
                    }
                } else {
                    const args = normalizeArgs(event);
                    if (args.path) {
                        toRender.set(args.path, args);
                    }
                }
            }

            const entries: SendMessageBatchRequestEntry[] = [];
            // TODO chunk splitting in case of big amount of events

            let i = 0;
            for (const render of toRender.values()) {
                const id = `${render.configuration?.db?.namespace}/${render.path}`;
                entries.push({
                    Id: i.toString(),
                    MessageBody: JSON.stringify(render),
                    MessageDeduplicationId: id,
                    MessageGroupId: id
                });
                i++;
            }

            const result = await sqsClient
                .sendMessageBatch({
                    QueueUrl: params.sqsQueueUrl,
                    Entries: entries
                })
                .promise();

            if (result.Failed.length) {
                console.error("Failed to deliver some of messages");
                console.error(JSON.stringify(result.Failed));
            }
        }
    };

    function normalizeArgs(args: Args): Args {
        return {
            path: args.path,
            configuration: {
                db: args.configuration?.db,
                meta: {
                    locale: args.configuration?.meta?.locale,
                    tenant: args.configuration?.meta?.tenant
                }
            }
        };
    }
};