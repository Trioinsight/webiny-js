import { Dispatch, SetStateAction } from "react";
import { ApolloQueryResult } from "apollo-client/core/types";
import { FetchResult } from "apollo-link";
import { Loading } from "~/types";

/**
 * A simple wrapper for Apollo fetching operations that handles the `loading` state as side effect.
 *
 * @param loadingHandler: function that handle the loading state.
 * @param apolloQuery: Apollo Query or Mutation
 */
export const apolloFetchingHandler = async (
    loadingHandler: () => void,
    apolloQuery: () => Promise<ApolloQueryResult<any> | FetchResult<any>>
) => {
    loadingHandler();

    const response = await apolloQuery();

    loadingHandler();

    return response;
};

/**
 * A simple function to handle `loading` state.
 *
 * @param context: string that define where the context the operation works.
 * @param action: the `action` that has been performed.
 * @param setState: the logic to update the loading state.
 */
export const loadingHandler = <T extends string>(
    context: string,
    action: T,
    setState: Dispatch<SetStateAction<Loading<T>>>
): void => {
    setState(state => {
        const currentContext = state[context] || {};
        const currentAction = currentContext[action] || false;

        return {
            ...state,
            [context]: {
                ...currentContext,
                [action]: !currentAction
            }
        };
    });
};
