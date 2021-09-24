import { ElementStylesHandler } from "~/types";

const margin: ElementStylesHandler = ({ element, displayModeName }) => {
    const { margin } = element.data.settings;
    if (!margin || !margin[displayModeName]) {
        return;
    }

    const values = margin[displayModeName];
    if (values.advanced) {
        return {
            marginTop: values.top,
            marginRight: values.right,
            marginBottom: values.bottom,
            marginLeft: values.left
        };
    } else {
        return { margin: values.all };
    }
};

export const createMargin = () => margin;