import { DependencyContainer } from "tsyringe";

import { IPostDBLoadModAsync } from "@spt/models/external/IPostDBLoadModAsync";
import { DatabaseServer } from "@spt/servers/DatabaseServer";
import { ItemHelper } from "@spt/helpers/ItemHelper";
import { BaseClasses } from "@spt/models/enums/BaseClasses";
import { RagfairServerHelper } from "@spt/helpers/RagfairServerHelper";
import { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import { PreSptModLoader } from "@spt/loaders/PreSptModLoader";
import { ConfigTypes } from "@spt/models/enums/ConfigTypes";
import { IRagfairConfig } from "@spt/models/spt/config/IRagfairConfig";
import { ConfigServer } from "@spt/servers/ConfigServer";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { MinMax } from "@spt/models/common/MinMax";
import { ITemplateItem } from "@spt/models/eft/common/tables/ITemplateItem";

class ItemValuation implements IPreSptLoadMod, IPostDBLoadModAsync
{
    private static container: DependencyContainer;

    private static rairaiAmmoStats: boolean;
    private static liveFleaPrices: boolean;
    private static realism: boolean;
    private static colorConverter: boolean;

    private static fs = require("fs");
    private static modConfig: Config = require("../config/config.json");

    private static localeTable;
    private static originalLocaleTable;
    private static originalPriceTable;

    private static updateTimer: NodeJS.Timeout;
    private static updateNumber: number = 0;
    private static itemsUpdated: number = 0;

    private static armourSlotsToCheck = [
        "helmet_top",
        "helmet_back",
        "helmet_ears",
        "helmet_eyes",
        "helmet_jaw",
        "front_plate",
        "back_plate",
        "soft_armor_front",
        "soft_armor_back",
        "soft_armor_left",
        "soft_armor_right",
        "collar",
        "groin",
        "groin_back",
        "shoulder_l",
        "shoulder_r"
    ]

    public preSptLoad(container: DependencyContainer): void 
    {
        const preSptModLoader: PreSptModLoader = container.resolve<PreSptModLoader>("PreSptModLoader");
        const logger = container.resolve<ILogger>("WinstonLogger");
        ItemValuation.rairaiAmmoStats = preSptModLoader.getImportedModsNames().includes("rairaitheraichu-ammostats");
        ItemValuation.liveFleaPrices = preSptModLoader.getImportedModsNames().includes("zzDrakiaXYZ-LiveFleaPrices");
        ItemValuation.realism = preSptModLoader.getImportedModsNames().includes("SPT-Realism");

        if (!ItemValuation.isColourConverterInstalled())
        {
            ItemValuation.modConfig.badColour = ItemValuation.colorConverter ? ItemValuation.modConfig.badColour : "grey";
            ItemValuation.modConfig.poorColour = ItemValuation.colorConverter ? ItemValuation.modConfig.poorColour :  "default";
            ItemValuation.modConfig.fairColour = ItemValuation.colorConverter ? ItemValuation.modConfig.fairColour :  "green";
            ItemValuation.modConfig.goodColour = ItemValuation.colorConverter ? ItemValuation.modConfig.goodColour :  "blue";
            ItemValuation.modConfig.veryGoodColour = ItemValuation.colorConverter ? ItemValuation.modConfig.veryGoodColour :  "violet";
            ItemValuation.modConfig.exceptionalColour = ItemValuation.colorConverter ? ItemValuation.modConfig.exceptionalColour :  "yellow";
            ItemValuation.modConfig.fleaBannedColour = ItemValuation.colorConverter ? ItemValuation.modConfig.fleaBannedColour :  "tracerRed";
            console.log("[ItemValuation] ColorConverterAPI not found. If you want custom colours, install ColorConverterAPI.")
        }
    }

    public async postDBLoadAsync(container: DependencyContainer): Promise<void>
    {
        await ItemValuation.delay(1500);

        ItemValuation.container = container;
        ItemValuation.originalPriceTable = structuredClone(container.resolve<DatabaseServer>("DatabaseServer").getTables().templates.prices);
        ItemValuation.originalLocaleTable = structuredClone(container.resolve<DatabaseServer>("DatabaseServer").getTables().locales.global);

        await ItemValuation.setPriceColouration(true);

        if (ItemValuation.liveFleaPrices)
        {
            ItemValuation.updateTimer = setInterval(ItemValuation.setPriceColouration, (60 * 60 * 1000));
        }
    }

    private static delay(ms: number): Promise<void> 
    {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    static async setPriceColouration(firstUpdate = false): Promise<boolean>
    {
        const start = performance.now();

        const databaseServer = ItemValuation.container.resolve<DatabaseServer>("DatabaseServer");
        const ragfairServerHelper = ItemValuation.container.resolve<RagfairServerHelper>("RagfairServerHelper");
        const ragfairConfig = ItemValuation.container.resolve<ConfigServer>("ConfigServer").getConfig(ConfigTypes.RAGFAIR) as IRagfairConfig;
        const itemHelper = ItemValuation.container.resolve<ItemHelper>("ItemHelper");
        ItemValuation.localeTable = databaseServer.getTables().locales.global;
        const itemTable = databaseServer.getTables().templates.items;
        const priceTable = databaseServer.getTables().templates.prices;
        const handbookTable = databaseServer.getTables().templates.handbook.Items;

        console.log("[ItemValuation] Updating item information");
        ItemValuation.updateNumber++

        for (const item in itemTable)
        {
            if (itemHelper.isOfBaseclass(item, BaseClasses.LOOT_CONTAINER)) continue;
            if (!firstUpdate && ItemValuation.originalPriceTable[item] == priceTable[item]) continue;

            // If item is ammo, and ammo stats is installed, skip
            if (ItemValuation.rairaiAmmoStats && itemHelper.isOfBaseclass(item, BaseClasses.AMMO)) continue;

            // Get price, if not found - use handbook
            let price = priceTable[item];
            const itemHandbookPrice = handbookTable.find((handbookItem) => handbookItem.Id === item)?.Price ?? 0
            if (!price)
            {
                price = itemHandbookPrice;
            }

            // Check if item's baseclass is in the unreasonable mod prices, and adjust it's price accordingly for colouration
            for (const baseClass in ragfairConfig.dynamic.unreasonableModPrices)
            {
                if (itemHelper.isOfBaseclass(item, baseClass))
                {
                    if (price > itemHandbookPrice * ragfairConfig.dynamic.unreasonableModPrices[baseClass].handbookPriceOverMultiplier) 
                    {
                        price = itemHandbookPrice * ragfairConfig.dynamic.unreasonableModPrices[baseClass].newPriceHandbookMultiplier;
                    }
                }
            }

            // Get item height & width, skip if not found, calculate the price per slot
            const height = itemTable[item]?._props?.Height;
            const width = itemTable[item]?._props?.Width;
            if (!height || !width) continue;
            const pricePerSlot = Math.round(price / (height * width));

            // Check if item is valid for flea
            const validFleaItem = ragfairServerHelper.isItemValidRagfairItem([true, itemTable[item]]);

            // Set background colour depending on baseclass
            let newBackgroundColour;
            let descriptionPrice;
            let addDescription = false;
            let perSlotDescription = false;

            if (itemHelper.isOfBaseclass(item, BaseClasses.WEAPON))
            {
                newBackgroundColour = ItemValuation.getWeaponColour(price, validFleaItem);
                descriptionPrice = price;
                addDescription = true;
            } 
            else if (itemHelper.isOfBaseclass(item, BaseClasses.AMMO))
            {
                const penetration = itemTable[item]._props.PenetrationPower;
                newBackgroundColour = ItemValuation.getAmmoColour(penetration, validFleaItem);
                descriptionPrice = price;
                addDescription = true;
            } 
            else if (itemHelper.isOfBaseclass(item, BaseClasses.KEY))
            {
                newBackgroundColour = ItemValuation.getKeyColour(price, validFleaItem);
                descriptionPrice = price;
                addDescription = true;
            } 
            else if (itemHelper.isOfBaseclasses(item, [BaseClasses.ARMORED_EQUIPMENT, BaseClasses.VEST]))
            {
                if (itemTable[item]._props.armorClass == 0)
                {
                    const itemSlots = itemTable[item]._props.Slots;
                    if (itemSlots.length === 0)
                    {
                        newBackgroundColour = ItemValuation.getItemColour(pricePerSlot, validFleaItem);
                        ItemValuation.addPriceToLocales(pricePerSlot, validFleaItem, item, true);
                        if (!newBackgroundColour) continue;
                        itemTable[item]._props.BackgroundColor = newBackgroundColour;
                        ItemValuation.itemsUpdated++;
                        continue;
                    }
                    const compatiblePlateTplPool = [];

                    for (const slot in itemSlots)
                    {
                        if (!ItemValuation.armourSlotsToCheck.includes(itemSlots[slot]._name.toLowerCase())) continue;

                        const itemSlotDefaultPlate = itemSlots[slot]._props.filters[0].Plate ?? "";
                        if (!itemSlotDefaultPlate) continue;

                        compatiblePlateTplPool.push(itemSlotDefaultPlate);
                    }
                    if (compatiblePlateTplPool.length === 0) continue;
                    const platesFromDb = compatiblePlateTplPool.map((plateTpl) => itemHelper.getItem(plateTpl)[1]);
                    const minMaxPlates = ItemValuation.getMinMaxArmorPlateClass(platesFromDb);

                    newBackgroundColour = ItemValuation.getArmourColour(minMaxPlates.max, validFleaItem);
                }
                else
                {
                    newBackgroundColour = ItemValuation.getArmourColour(itemTable[item]._props.armorClass as number, validFleaItem);
                }
                descriptionPrice = price;
                addDescription = true;
            }
            else if (itemHelper.isOfBaseclass(item, BaseClasses.MONEY))
            {
                newBackgroundColour = "black";
            }
            else
            {
                newBackgroundColour = ItemValuation.getItemColour(pricePerSlot, validFleaItem);
                descriptionPrice = pricePerSlot;
                addDescription = true;
                perSlotDescription = true;
            }

            if (addDescription) ItemValuation.addPriceToLocales(descriptionPrice, validFleaItem, item, perSlotDescription);
            if (!newBackgroundColour) continue;
            itemTable[item]._props.BackgroundColor = newBackgroundColour;
            ItemValuation.itemsUpdated++;
        }

        // Reset the original price table to the new price table
        ItemValuation.originalPriceTable = structuredClone(priceTable);

        const timeTaken = performance.now() - start;
        console.log(`[ItemValuation] ${ItemValuation.itemsUpdated} items updated, took ${timeTaken.toFixed(2)}ms.`);
        ItemValuation.itemsUpdated = 0;
        return true;
    }
    private static getItemColour(pricePerSlot: number, availableOnFlea: boolean): string
    {
        if (ItemValuation.modConfig.colourFleaBannedItems && !availableOnFlea) return ItemValuation.modConfig.fleaBannedColour;
        if (!ItemValuation.modConfig.colourNormalItems) return "";
        if (pricePerSlot < ItemValuation.modConfig.badItemPerSlotMaxValue) return ItemValuation.modConfig.badColour;
        if (pricePerSlot < ItemValuation.modConfig.poorItemPerSlotMaxValue) return ItemValuation.modConfig.poorColour;
        if (pricePerSlot < ItemValuation.modConfig.fairItemPerSlotMaxValue) return ItemValuation.modConfig.fairColour;
        if (pricePerSlot < ItemValuation.modConfig.goodItemPerSlotMaxValue) return ItemValuation.modConfig.goodColour;
        if (pricePerSlot < ItemValuation.modConfig.veryGoodItemPerSlotMaxValue) return ItemValuation.modConfig.veryGoodColour;
        return ItemValuation.modConfig.exceptionalColour;
    }

    private static getKeyColour(pricePerSlot: number, availableOnFlea: boolean): string
    {
        if (ItemValuation.modConfig.colourFleaBannedKeys && !availableOnFlea) return ItemValuation.modConfig.fleaBannedColour;
        if (!ItemValuation.modConfig.colourKeys) return "";
        if (pricePerSlot < ItemValuation.modConfig.badKeyMaxValue) return ItemValuation.modConfig.badColour;
        if (pricePerSlot < ItemValuation.modConfig.poorKeyMaxValue) return ItemValuation.modConfig.poorColour;
        if (pricePerSlot < ItemValuation.modConfig.fairKeyMaxValue) return ItemValuation.modConfig.fairColour;
        if (pricePerSlot < ItemValuation.modConfig.goodKeyMaxValue) return ItemValuation.modConfig.goodColour;
        if (pricePerSlot < ItemValuation.modConfig.veryGoodKeyMaxValue) return ItemValuation.modConfig.veryGoodColour;
        return ItemValuation.modConfig.exceptionalColour;
    }

    private static getArmourColour(armorClass: number, availableOnFlea: boolean): string
    {
        if (ItemValuation.modConfig.colourFleaBannedArmour && !availableOnFlea) return ItemValuation.modConfig.fleaBannedColour;
        if (!ItemValuation.modConfig.colourArmours) return "";

        
        if (ItemValuation.realism)
        {
            if (armorClass <= 1) return ItemValuation.modConfig.badColour;
            if (armorClass <= 3) return ItemValuation.modConfig.poorColour;
            if (armorClass <= 5) return ItemValuation.modConfig.fairColour;
            if (armorClass <= 7) return ItemValuation.modConfig.goodColour;
            if (armorClass <= 9) return ItemValuation.modConfig.veryGoodColour;
        }

        if (armorClass <= ItemValuation.modConfig.badArmorMaxPlates) return ItemValuation.modConfig.badColour;
        if (armorClass <= ItemValuation.modConfig.poorArmorMaxPlates) return ItemValuation.modConfig.poorColour;
        if (armorClass <= ItemValuation.modConfig.fairArmorMaxPlates) return ItemValuation.modConfig.fairColour;
        if (armorClass <= ItemValuation.modConfig.goodArmorMaxPlates) return ItemValuation.modConfig.goodColour;
        if (armorClass <= ItemValuation.modConfig.veryGoodArmorMaxPlates) return ItemValuation.modConfig.veryGoodColour;
        return ItemValuation.modConfig.exceptionalColour;
    }
    
    private static getWeaponColour(price: number, availableOnFlea: boolean): string
    {
        if (ItemValuation.modConfig.colourFleaBannedWeapons && !availableOnFlea) return ItemValuation.modConfig.fleaBannedColour;
        if (!ItemValuation.modConfig.colourWeapons) return "";
        if (price < ItemValuation.modConfig.badWeaponMaxValue) return ItemValuation.modConfig.badColour;
        if (price < ItemValuation.modConfig.poorWeaponMaxValue) return ItemValuation.modConfig.poorColour;
        if (price < ItemValuation.modConfig.fairWeaponMaxValue) return ItemValuation.modConfig.fairColour;
        if (price < ItemValuation.modConfig.goodWeaponMaxValue) return ItemValuation.modConfig.goodColour;
        if (price < ItemValuation.modConfig.veryGoodWeaponMaxValue) return ItemValuation.modConfig.veryGoodColour;
        return ItemValuation.modConfig.exceptionalColour;
    }

    private static getAmmoColour(pen: number, availableOnFlea: boolean): string
    {
        if (ItemValuation.modConfig.colourFleaBannedAmmo && !availableOnFlea) return ItemValuation.modConfig.fleaBannedColour;
        if (!ItemValuation.modConfig.colourAmmo) return "";

        if (ItemValuation.realism)
        {
            if (pen <= 10) return ItemValuation.modConfig.badColour;
            if (pen <= 30) return ItemValuation.modConfig.poorColour;
            if (pen <= 50) return ItemValuation.modConfig.fairColour;
            if (pen <= 70) return ItemValuation.modConfig.goodColour;
            if (pen <= 90) return ItemValuation.modConfig.veryGoodColour;
        }

        if (pen <= ItemValuation.modConfig.badAmmoMaxPen) return ItemValuation.modConfig.badColour;
        if (pen <= ItemValuation.modConfig.poorAmmoMaxPen) return ItemValuation.modConfig.poorColour;
        if (pen <= ItemValuation.modConfig.fairAmmoMaxPen) return ItemValuation.modConfig.fairColour;
        if (pen <= ItemValuation.modConfig.goodAmmoMaxPen) return ItemValuation.modConfig.goodColour;
        if (pen <= ItemValuation.modConfig.veryGoodAmmoMaxPen) return ItemValuation.modConfig.veryGoodColour;
        return ItemValuation.modConfig.exceptionalColour;
    }

    private static addPriceToLocales(price: number, availableOnFlea: boolean, itemID: string, perSlotDescription = false): void
    {
        for (const locale in ItemValuation.localeTable)
        {
            const priceType = perSlotDescription ? "Price Per Slot:" : "Price:"
            const originalDescription = ItemValuation.originalLocaleTable[locale][`${itemID} Description`]; 
            ItemValuation.localeTable[locale][`${itemID} Description`] = `${priceType} ${ItemValuation.formatToRoubles(price)} | ${availableOnFlea ? "<color=#17751b>Not Flea Banned</color>" : "<color=#751717>Flea Banned</color>"}\n\n` + originalDescription;
        }
    }

    private static formatToRoubles(amount: number): string 
    {
        return new Intl.NumberFormat("ru-RU", {
            style: "currency",
            currency: "RUB",
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        }).format(amount);
    }

    private static isColourConverterInstalled(): boolean 
    {
        const pluginName = "rairai.colorconverterapi.dll";
        // Fails if there's no ./BepInEx/plugins/ folder
        try 
        {
            const pluginList = ItemValuation.fs.readdirSync("./BepInEx/plugins").map(plugin => plugin.toLowerCase());
            ItemValuation.colorConverter = pluginList.includes(pluginName);
            return ItemValuation.colorConverter;
        }
        catch 
        {
            return false;
        }
    }

    private static getMinMaxArmorPlateClass(platePool: ITemplateItem[]): MinMax 
    {
        platePool.sort((x, y) => {
            if (x._props.armorClass < y._props.armorClass) return -1;
            if (x._props.armorClass > y._props.armorClass) return 1;
            return 0;
        });

        return {
            min: Number(platePool[0]._props.armorClass),
            max: Number(platePool[platePool.length - 1]._props.armorClass)
        };
    }
}

interface Config
{
    colourNormalItems: boolean,
    colourFleaBannedItems: boolean,
    badItemPerSlotMaxValue: number,
    poorItemPerSlotMaxValue: number,
    fairItemPerSlotMaxValue: number,
    goodItemPerSlotMaxValue: number,
    veryGoodItemPerSlotMaxValue: number,

    colourKeys: boolean,
    colourFleaBannedKeys: boolean,
    badKeyMaxValue: number,
    poorKeyMaxValue: number,
    fairKeyMaxValue: number,
    goodKeyMaxValue: number,
    veryGoodKeyMaxValue: number,

    colourAmmo: boolean,
    colourFleaBannedAmmo: boolean,
    badAmmoMaxPen: number,
    poorAmmoMaxPen: number,
    fairAmmoMaxPen: number,
    goodAmmoMaxPen: number,
    veryGoodAmmoMaxPen: number,
    
    colourWeapons: boolean,
    colourFleaBannedWeapons: boolean,
    badWeaponMaxValue: number,
    poorWeaponMaxValue: number,
    fairWeaponMaxValue: number,
    goodWeaponMaxValue: number,
    veryGoodWeaponMaxValue: number,

    colourArmours: boolean,
    colourFleaBannedArmour: boolean,
    badArmorMaxPlates: number,
    poorArmorMaxPlates: number,
    fairArmorMaxPlates: number,
    goodArmorMaxPlates: number,
    veryGoodArmorMaxPlates: number,

    badColour: string,
    poorColour: string,
    fairColour: string,
    goodColour: string,
    veryGoodColour: string,
    exceptionalColour: string,

    fleaBannedColour: string
}

export const mod = new ItemValuation();
