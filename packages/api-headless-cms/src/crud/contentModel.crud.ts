import {
    CmsContext,
    CmsModel,
    CmsModelContext,
    CmsModelManager,
    CmsModelPermission,
    HeadlessCmsStorageOperations,
    OnModelBeforeCreateTopicParams,
    OnModelAfterCreateTopicParams,
    OnModelBeforeUpdateTopicParams,
    OnModelAfterUpdateTopicParams,
    OnModelBeforeDeleteTopicParams,
    OnModelAfterDeleteTopicParams,
    OnModelInitializeParams,
    OnModelBeforeCreateFromTopicParams,
    OnModelAfterCreateFromTopicParams,
    CmsModelCreateInput,
    CmsModelUpdateInput,
    CmsModelCreateFromInput,
    CmsModelField
} from "~/types";
import DataLoader from "dataloader";
import { NotFoundError } from "@webiny/handler-graphql";
import { contentModelManagerFactory } from "./contentModel/contentModelManagerFactory";
import {
    CreateContentModelModel,
    CreateContentModelModelFrom,
    UpdateContentModelModel
} from "./contentModel/models";
import { createFieldModels } from "./contentModel/createFieldModels";
import WebinyError from "@webiny/error";
import { Tenant } from "@webiny/api-tenancy/types";
import { I18NLocale } from "@webiny/api-i18n/types";
import { SecurityIdentity } from "@webiny/api-security/types";
import { createTopic } from "@webiny/pubsub";
import { assignModelBeforeCreate } from "./contentModel/beforeCreate";
import { assignModelBeforeUpdate } from "./contentModel/beforeUpdate";
import { assignModelBeforeDelete } from "./contentModel/beforeDelete";
import { assignModelAfterCreate } from "./contentModel/afterCreate";
import { assignModelAfterUpdate } from "./contentModel/afterUpdate";
import { assignModelAfterDelete } from "./contentModel/afterDelete";
import { assignModelAfterCreateFrom } from "./contentModel/afterCreateFrom";
import { CmsModelPlugin } from "~/plugins/CmsModelPlugin";
import { checkPermissions } from "~/utils/permissions";
import { filterAsync } from "~/utils/filterAsync";
import { checkOwnership, validateOwnership } from "~/utils/ownership";
import { checkModelAccess, validateModelAccess } from "~/utils/access";
import { validateModelFields } from "~/crud/contentModel/validateModelFields";
import semver, { SemVer } from "semver";

/**
 * TODO: remove for 5.34.0
 * Required because of the 5.33.0 upgrade.
 * Until the upgrade is done, API will break because there is no storageId assigned.
 */
const featureVersion = semver.coerce("5.33.0") as SemVer;

const attachStorageIdToFields = (fields: CmsModelField[]): CmsModelField[] => {
    return fields.map(field => {
        if (field.settings?.fields) {
            field.settings.fields = attachStorageIdToFields(field.settings.fields);
        }
        if (!field.storageId) {
            field.storageId = field.fieldId;
        }
        return field;
    });
};

const attachStorageIdToModelFields = (model: CmsModel): CmsModelField[] => {
    if (!model.webinyVersion) {
        return model.fields;
    }

    const version = semver.coerce(model.webinyVersion);
    if (!version) {
        return model.fields;
    }
    /**
     * Unfortunately we need to check for beta and next.
     * TODO remove after 5.33.0
     */
    if (model.webinyVersion.match(/beta|next/)) {
        return attachStorageIdToFields(model.fields);
    }
    if (semver.compare(version, featureVersion) >= 0) {
        return model.fields;
    }
    return attachStorageIdToFields(model.fields);
};

export interface CreateModelsCrudParams {
    getTenant: () => Tenant;
    getLocale: () => I18NLocale;
    storageOperations: HeadlessCmsStorageOperations;
    context: CmsContext;
    getIdentity: () => SecurityIdentity;
}
export const createModelsCrud = (params: CreateModelsCrudParams): CmsModelContext => {
    const { getTenant, getIdentity, getLocale, storageOperations, context } = params;

    const loaders = {
        listModels: new DataLoader(async () => {
            const models = await storageOperations.models.list({
                where: {
                    tenant: getTenant().id,
                    locale: getLocale().code
                }
            });
            return [
                models.map(model => {
                    return {
                        ...model,
                        fields: attachStorageIdToModelFields(model),
                        tenant: model.tenant || getTenant().id,
                        locale: model.locale || getLocale().code
                    };
                })
            ];
        })
    };

    const clearModelsCache = (): void => {
        for (const loader of Object.values(loaders)) {
            loader.clearAll();
        }
    };

    const managers = new Map<string, CmsModelManager>();
    const updateManager = async (
        context: CmsContext,
        model: CmsModel
    ): Promise<CmsModelManager> => {
        const manager = await contentModelManagerFactory(context, model);
        managers.set(model.modelId, manager);
        return manager;
    };

    const checkModelPermissions = (check: string): Promise<CmsModelPermission> => {
        return checkPermissions(context, "cms.contentModel", { rwd: check });
    };

    const getModelsAsPlugins = (): CmsModel[] => {
        const tenant = getTenant().id;
        const locale = getLocale().code;

        const models = context.plugins
            .byType<CmsModelPlugin>(CmsModelPlugin.type)
            /**
             * We need to filter out models that are not for this tenant or locale.
             * If it does not have tenant or locale define, it is for every locale and tenant
             */
            .filter(plugin => {
                const { tenant: t, locale: l } = plugin.contentModel;
                if (t && t !== tenant) {
                    return false;
                } else if (l && l !== locale) {
                    return false;
                }
                return true;
            })
            .map<CmsModel>(plugin => {
                return {
                    ...plugin.contentModel,
                    tenant,
                    locale,
                    webinyVersion: context.WEBINY_VERSION
                };
            });
        /**
         * Only point where we can truly validate the user model is in the runtime.
         */
        for (const model of models) {
            validateModelFields({
                model,
                plugins: context.plugins
            });
        }
        return models;
    };

    const modelsGet = async (modelId: string): Promise<CmsModel> => {
        const pluginModel = getModelsAsPlugins().find(model => model.modelId === modelId);

        if (pluginModel) {
            return pluginModel;
        }

        const model = await storageOperations.models.get({
            tenant: getTenant().id,
            locale: getLocale().code,
            modelId
        });

        if (!model) {
            throw new NotFoundError(`Content model "${modelId}" was not found!`);
        }

        return {
            ...model,
            tenant: model.tenant || getTenant().id,
            locale: model.locale || getLocale().code
        };
    };

    const modelsList = async (): Promise<CmsModel[]> => {
        const databaseModels = await loaders.listModels.load("listModels");

        const pluginsModels = getModelsAsPlugins();

        return databaseModels.concat(pluginsModels);
    };

    const listModels = async () => {
        const permission = await checkModelPermissions("r");
        const models = await modelsList();
        return filterAsync(models, async model => {
            if (!validateOwnership(context, permission, model)) {
                return false;
            }
            return validateModelAccess(context, model);
        });
    };

    const getModel = async (modelId: string): Promise<CmsModel> => {
        const permission = await checkModelPermissions("r");

        const model = await modelsGet(modelId);

        checkOwnership(context, permission, model);
        await checkModelAccess(context, model);

        return model;
    };

    const getModelManager: CmsModelContext["getModelManager"] = async (
        target
    ): Promise<CmsModelManager> => {
        const modelId = typeof target === "string" ? target : target.modelId;
        if (managers.has(modelId)) {
            return managers.get(modelId) as CmsModelManager;
        }
        const models = await modelsList();
        const model = models.find(m => m.modelId === modelId);
        if (!model) {
            throw new NotFoundError(`There is no content model "${modelId}".`);
        }
        return await updateManager(context, model);
    };

    // create
    const onModelBeforeCreate =
        createTopic<OnModelBeforeCreateTopicParams>("cms.onModelBeforeCreate");
    const onModelAfterCreate = createTopic<OnModelAfterCreateTopicParams>("cms.onModelAfterCreate");
    // create from
    const onModelBeforeCreateFrom = createTopic<OnModelBeforeCreateFromTopicParams>(
        "cms.onModelBeforeCreateFrom"
    );
    const onModelAfterCreateFrom = createTopic<OnModelAfterCreateFromTopicParams>(
        "cms.onModelAfterCreateFrom"
    );
    // update
    const onModelBeforeUpdate =
        createTopic<OnModelBeforeUpdateTopicParams>("cms.onModelBeforeUpdate");
    const onModelAfterUpdate = createTopic<OnModelAfterUpdateTopicParams>("cms.onModelAfterUpdate");
    // delete
    const onModelBeforeDelete =
        createTopic<OnModelBeforeDeleteTopicParams>("cms.onModelBeforeDelete");
    const onModelAfterDelete = createTopic<OnModelAfterDeleteTopicParams>("cms.onModelAfterDelete");

    const onModelInitialize = createTopic<OnModelInitializeParams>("cms.onModelInitialize");
    /**
     * We need to assign some default behaviors.
     */
    assignModelBeforeCreate({
        onModelBeforeCreate,
        onModelBeforeCreateFrom,
        plugins: context.plugins,
        storageOperations
    });
    assignModelAfterCreate({
        context,
        onModelAfterCreate
    });
    assignModelBeforeUpdate({
        onModelBeforeUpdate,
        plugins: context.plugins,
        storageOperations
    });
    assignModelAfterUpdate({
        context,
        onModelAfterUpdate
    });
    assignModelAfterCreateFrom({
        context,
        onModelAfterCreateFrom
    });
    assignModelBeforeDelete({
        onModelBeforeDelete,
        plugins: context.plugins,
        storageOperations
    });
    assignModelAfterDelete({
        context,
        onModelAfterDelete
    });

    return {
        /**
         * Deprecated - will be removed in 5.36.0
         */
        onBeforeModelCreate: onModelBeforeCreate,
        onAfterModelCreate: onModelAfterCreate,
        onBeforeModelCreateFrom: onModelBeforeCreateFrom,
        onAfterModelCreateFrom: onModelAfterCreateFrom,
        onBeforeModelUpdate: onModelBeforeUpdate,
        onAfterModelUpdate: onModelAfterUpdate,
        onBeforeModelDelete: onModelBeforeDelete,
        onAfterModelDelete: onModelAfterDelete,
        /**
         * Released in 5.34.0
         */
        onModelBeforeCreate,
        onModelAfterCreate,
        onModelBeforeCreateFrom,
        onModelAfterCreateFrom,
        onModelBeforeUpdate,
        onModelAfterUpdate,
        onModelBeforeDelete,
        onModelAfterDelete,
        onModelInitialize,
        clearModelsCache,
        getModel,
        listModels,
        async createModel(inputData) {
            await checkModelPermissions("w");

            const createdData = new CreateContentModelModel().populate(inputData);
            await createdData.validate();
            const input: CmsModelCreateInput = await createdData.toJSON();

            context.security.disableAuthorization();
            const group = await context.cms.getGroup(input.group);
            context.security.enableAuthorization();
            if (!group) {
                throw new NotFoundError(`There is no group "${input.group}".`);
            }

            const fields = await createFieldModels(input.fields);

            const identity = getIdentity();
            const model: CmsModel = {
                name: input.name,
                description: input.description || "",
                modelId: input.modelId || "",
                titleFieldId: "id",
                locale: getLocale().code,
                tenant: getTenant().id,
                group: {
                    id: group.id,
                    name: group.name
                },
                createdBy: {
                    id: identity.id,
                    displayName: identity.displayName,
                    type: identity.type
                },
                createdOn: new Date().toISOString(),
                savedOn: new Date().toISOString(),
                fields,
                lockedFields: [],
                layout: input.layout || [],
                webinyVersion: context.WEBINY_VERSION
            };

            await onModelBeforeCreate.publish({
                input,
                model
            });

            const createdModel = await storageOperations.models.create({
                model
            });

            loaders.listModels.clearAll();

            await updateManager(context, model);

            await onModelAfterCreate.publish({
                input,
                model: createdModel
            });

            return createdModel;
        },
        /**
         * Method does not check for permissions or ownership.
         * @internal
         */
        async updateModelDirect(params) {
            const { model: initialModel, original } = params;

            const model: CmsModel = {
                ...initialModel,
                tenant: initialModel.tenant || getTenant().id,
                locale: initialModel.locale || getLocale().code,
                webinyVersion: context.WEBINY_VERSION
            };

            await onModelBeforeUpdate.publish({
                input: {} as CmsModelUpdateInput,
                original,
                model
            });

            const resultModel = await storageOperations.models.update({
                model
            });

            await updateManager(context, resultModel);

            loaders.listModels.clearAll();

            await onModelAfterUpdate.publish({
                input: {} as CmsModelUpdateInput,
                original,
                model: resultModel
            });

            return resultModel;
        },
        async createModelFrom(modelId, data) {
            await checkModelPermissions("w");
            /**
             * Get a model record; this will also perform ownership validation.
             */
            const original = await getModel(modelId);

            const createdData = new CreateContentModelModelFrom().populate({
                name: data.name,
                modelId: data.modelId,
                description: data.description || original.description,
                group: data.group,
                locale: data.locale
            });

            await createdData.validate();
            const input: CmsModelCreateFromInput = await createdData.toJSON();

            const locale = await context.i18n.getLocale(input.locale || original.locale);
            if (!locale) {
                throw new NotFoundError(`There is no locale "${input.locale}".`);
            }
            /**
             * Use storage operations directly because we cannot get group from different locale via context methods.
             */
            const group = await context.cms.storageOperations.groups.get({
                id: input.group,
                tenant: original.tenant,
                locale: locale.code
            });
            if (!group) {
                throw new NotFoundError(`There is no group "${input.group}".`);
            }

            const identity = getIdentity();
            const model: CmsModel = {
                ...original,
                locale: locale.code,
                group: {
                    id: group.id,
                    name: group.name
                },
                name: input.name,
                modelId: input.modelId || "",
                description: input.description || "",
                createdBy: {
                    id: identity.id,
                    displayName: identity.displayName,
                    type: identity.type
                },
                createdOn: new Date().toISOString(),
                savedOn: new Date().toISOString(),
                lockedFields: [],
                webinyVersion: context.WEBINY_VERSION
            };

            await onModelBeforeCreateFrom.publish({
                input,
                model,
                original
            });

            const createdModel = await storageOperations.models.create({
                model
            });

            loaders.listModels.clearAll();

            await updateManager(context, model);

            await onModelAfterCreateFrom.publish({
                input,
                original,
                model: createdModel
            });

            return createdModel;
        },
        async updateModel(modelId, inputData) {
            await checkModelPermissions("w");

            // Get a model record; this will also perform ownership validation.
            const original = await getModel(modelId);

            const updatedData = new UpdateContentModelModel().populate(inputData);
            await updatedData.validate();

            const input: CmsModelUpdateInput = await updatedData.toJSON({ onlyDirty: true });
            if (Object.keys(input).length === 0) {
                /**
                 * We need to return the original if nothing is to be updated.
                 */
                return original;
            }
            let group: CmsModel["group"] = {
                id: original.group.id,
                name: original.group.name
            };
            if (input.group) {
                context.security.disableAuthorization();
                const groupData = await context.cms.getGroup(input.group);
                context.security.enableAuthorization();
                if (!groupData) {
                    throw new NotFoundError(`There is no group "${input.group}".`);
                }
                group = {
                    id: groupData.id,
                    name: groupData.name
                };
            }
            const fields = await createFieldModels(inputData.fields);
            const model: CmsModel = {
                ...original,
                ...input,
                group,
                tenant: original.tenant || getTenant().id,
                locale: original.locale || getLocale().code,
                webinyVersion: context.WEBINY_VERSION,
                fields,
                savedOn: new Date().toISOString()
            };

            await onModelBeforeUpdate.publish({
                input,
                original,
                model
            });

            const resultModel = await storageOperations.models.update({
                model
            });

            await updateManager(context, resultModel);

            await onModelAfterUpdate.publish({
                input,
                original,
                model: resultModel
            });

            return resultModel;
        },
        async deleteModel(modelId) {
            await checkModelPermissions("d");

            const model = await getModel(modelId);

            await onModelBeforeDelete.publish({
                model
            });

            try {
                await storageOperations.models.delete({
                    model
                });
            } catch (ex) {
                throw new WebinyError(
                    ex.message || "Could not delete the content model",
                    ex.code || "CONTENT_MODEL_DELETE_ERROR",
                    {
                        error: ex,
                        modelId: model.modelId
                    }
                );
            }

            await onModelAfterDelete.publish({
                model
            });

            managers.delete(model.modelId);
        },
        async initializeModel(modelId) {
            /**
             * We require that users have write permissions to initialize models.
             * Maybe introduce another permission for it?
             */
            await checkModelPermissions("w");

            const model = await getModel(modelId);

            await onModelInitialize.publish({ model });

            return true;
        },
        getModelManager,
        getEntryManager: async model => {
            return getModelManager(model);
        },
        getManagers: () => managers,
        getEntryManagers: () => managers
    };
};
