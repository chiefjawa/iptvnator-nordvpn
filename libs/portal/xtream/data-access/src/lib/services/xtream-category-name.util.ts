/** A live category as the store holds it: from the API or from the DB. */
export interface XtreamCategoryNameSource {
    readonly category_id?: string | number;
    readonly id?: string | number;
    readonly category_name?: string;
    readonly name?: string;
}

/**
 * Category names by the id a channel's `category_id` uses: an API category's
 * `category_id`, a stored category's row `id`. The name is a country hint
 * for the automatic XMLTV name match (`US| Sample` → `.us` guides).
 */
export function xtreamCategoryNames(
    categories: ReadonlyArray<XtreamCategoryNameSource> | null | undefined
): Map<string, string> {
    const names = new Map<string, string>();
    for (const category of categories ?? []) {
        const name = category?.category_name || category?.name;
        const id = category?.category_id ?? category?.id;
        if (name && id != null && id !== '') names.set(String(id), name);
    }
    return names;
}

/** The category name of a channel, or `null`. */
export function xtreamCategoryNameOf(
    names: ReadonlyMap<string, string>,
    categoryId: string | number | null | undefined
): string | null {
    return categoryId == null ? null : (names.get(String(categoryId)) ?? null);
}
