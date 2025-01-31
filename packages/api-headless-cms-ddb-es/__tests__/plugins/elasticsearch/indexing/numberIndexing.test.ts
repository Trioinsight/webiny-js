import numberIndexing from "~/elasticsearch/indexing/numberIndexing";
import { CmsModelFieldToElasticsearchPlugin } from "~/types";

describe("numberIndexing", () => {
    const plugin = numberIndexing() as Required<CmsModelFieldToElasticsearchPlugin>;

    const numbers: any[] = [
        [1, 1],
        [4382, 4382],
        [3924032, 3924032],
        [0.1235, 0.1235],
        [1.01, 1.01],
        [15.4300023, 15.4300023],
        [
            [15, 117.08],
            ["15", "117.08"]
        ],
        [
            [15.4300023, 15.4300021],
            ["15.4300023", "15.4300021"]
        ]
    ];
    test.each(numbers)("toIndex should transform %j to %j", (num: any, expected: any) => {
        const field: any = {
            storageId: "number"
        };
        const result = plugin.toIndex({ value: num, field } as any);

        expect(result.value).toEqual(expected);
    });
    const strings: any[] = [
        ["1", 1],
        ["4382", 4382],
        ["3924032", 3924032],
        ["0.1235", 0.1235],
        ["1.01", 1.01],
        ["15.4300023", 15.4300023],
        [15.4300023, 15.4300023],
        [
            ["15", "117.08"],
            [15, 117.08]
        ],
        [
            ["15.4300023", "15.4300021"],
            [15.4300023, 15.4300021]
        ]
    ];
    test.each(strings)("fromIndex should transform %j back to %j", (str: any, expected: any) => {
        const field: any = {
            storageId: "number"
        };
        const result = plugin.fromIndex({ value: str, field } as any);

        expect(result).toEqual(expected);
    });
});
