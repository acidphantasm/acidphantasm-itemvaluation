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

class ItemValuation implements IPreSptLoadMod, IPostDBLoadModAsync
{
    private static container: DependencyContainer;
    private static rairaiAmmoStats: boolean;
    private static modConfig: Config = require("../config/config.json");
    private static localeTable;
    private static originalLocaleTable;
    private static originalPriceTable;
    private static updateTimer: NodeJS.Timeout;
    private static nextUpdate: number = 0;
    private static updateNumber: number = 0;
    private static fs = require("fs");

    public preSptLoad(container: DependencyContainer): void 
    {
        const preSptModLoader: PreSptModLoader = container.resolve<PreSptModLoader>("PreSptModLoader");
        const logger = container.resolve<ILogger>("WinstonLogger");
        ItemValuation.rairaiAmmoStats = preSptModLoader.getImportedModsNames().includes("rairaitheraichu-ammostats");

        if (!ItemValuation.isColourConverterInstalled())
        {
            logger.error("[Item Valuation] not loaded. ColorConverterAPI not found. Please read the mod page for dependencies.");
            return;
        }
    }

    public async postDBLoadAsync(container: DependencyContainer): Promise<void>
    {
        ItemValuation.container = container;
        ItemValuation.originalPriceTable = container.resolve<DatabaseServer>("DatabaseServer").getTables().templates.prices;
        ItemValuation.originalLocaleTable = container.resolve<DatabaseServer>("DatabaseServer").getTables().locales.global;

        // Update prices on startup
        const currentTime = Math.floor(Date.now() / 1000);
        let updateColours = false;
        let firstUpdate = false;
        if (currentTime > ItemValuation.nextUpdate)
        {
            updateColours = true;
            firstUpdate = true;
        }

        if (!await ItemValuation.setPriceColouration(updateColours, firstUpdate))
        {
            console.log("Update failed")
            return;
        }

        ItemValuation.updateTimer = setInterval(ItemValuation.setPriceColouration, (60 * 60.1 * 1000));
    }

    static async setPriceColouration(updateColours = true, firstUpdate = false): Promise<boolean>
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

        if (updateColours)
        {
            ItemValuation.nextUpdate = Math.floor(Date.now() / 1000) + 3606;
            console.log("[ItemValuation] Updating Items" + ` ${firstUpdate ? "for the first time" : ""}`);
            ItemValuation.updateNumber++
        }
        for (const item in itemTable)
        {
            if (!firstUpdate && ItemValuation.originalPriceTable[item] == priceTable[item]) continue;

            // Get item details
            const itemDetails = itemHelper.getItem(item);

            // If item is ammo, and ammo stats is installed, skip
            if (ItemValuation.rairaiAmmoStats && itemHelper.isOfBaseclass(itemDetails[1]._id, BaseClasses.AMMO)) continue;

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
                if (itemHelper.isOfBaseclass(itemDetails[1]._id, baseClass))
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
            const validFleaItem = ragfairServerHelper.isItemValidRagfairItem(itemDetails);

            // Set background colour depending on baseclass
            let newBackgroundColour;
            let descriptionPrice;
            let addDescription = false;
            let perSlotDescription = false;

            if (itemHelper.isOfBaseclass(itemDetails[1]._id, BaseClasses.WEAPON) && ItemValuation.modConfig.colourWeapons)
            {
                newBackgroundColour = ItemValuation.getWeaponColour(price, validFleaItem);
                descriptionPrice = price;
                addDescription = true;
            } 
            else if (itemHelper.isOfBaseclass(itemDetails[1]._id, BaseClasses.AMMO) && ItemValuation.modConfig.colourAmmo)
            {
                newBackgroundColour = ItemValuation.getAmmoColour(price, validFleaItem);
                descriptionPrice = price;
                addDescription = true;
            }
            else if (itemHelper.isOfBaseclass(itemDetails[1]._id, BaseClasses.MONEY))
            {
                newBackgroundColour = "#000000";
            }
            else if (ItemValuation.modConfig.colourNormalItems) 
            {
                newBackgroundColour = ItemValuation.getItemColour(pricePerSlot, validFleaItem);
                descriptionPrice = pricePerSlot;
                addDescription = true;
                perSlotDescription = true;
            }
            else continue;

            if (addDescription) ItemValuation.addPriceToLocales(descriptionPrice, validFleaItem, itemDetails[1]._id, perSlotDescription);
            itemTable[item]._props.BackgroundColor = newBackgroundColour;
        }
        const timeTaken = performance.now() - start;
        console.log(`[ItemValuation] Update took ${timeTaken.toFixed(2)}`)
        return true;
    }
    private static getItemColour(pricePerSlot: number, availableOnFlea: boolean): string
    {
        if (ItemValuation.modConfig.colourFleaBannedItems && !availableOnFlea) return ItemValuation.modConfig.fleaBannedColour;
        if (pricePerSlot < ItemValuation.modConfig.badItemPerSlotMaxValue) return ItemValuation.modConfig.badColour;
        if (pricePerSlot < ItemValuation.modConfig.poorItemPerSlotMaxValue) return ItemValuation.modConfig.poorColour;
        if (pricePerSlot < ItemValuation.modConfig.fairItemPerSlotMaxValue) return ItemValuation.modConfig.fairColour;
        if (pricePerSlot < ItemValuation.modConfig.goodItemPerSlotMaxValue) return ItemValuation.modConfig.goodColour;
        if (pricePerSlot < ItemValuation.modConfig.veryGoodItemPerSlotMaxValue) return ItemValuation.modConfig.veryGoodColour;
        return ItemValuation.modConfig.exceptionalColour;
    }

    private static getWeaponColour(price: number, availableOnFlea: boolean): string
    {
        if (ItemValuation.modConfig.colourFleaBannedItems && !availableOnFlea) return ItemValuation.modConfig.fleaBannedColour;
        if (price < ItemValuation.modConfig.badWeaponMaxValue) return ItemValuation.modConfig.badColour;
        if (price < ItemValuation.modConfig.poorWeaponMaxValue) return ItemValuation.modConfig.poorColour;
        if (price < ItemValuation.modConfig.fairWeaponMaxValue) return ItemValuation.modConfig.fairColour;
        if (price < ItemValuation.modConfig.goodWeaponMaxValue) return ItemValuation.modConfig.goodColour;
        if (price < ItemValuation.modConfig.veryGoodWeaponMaxValue) return ItemValuation.modConfig.veryGoodColour;
        return ItemValuation.modConfig.exceptionalColour;
    }

    private static getAmmoColour(price: number, availableOnFlea: boolean): string
    {
        if (ItemValuation.modConfig.colourFleaBannedItems && !availableOnFlea) return ItemValuation.modConfig.fleaBannedColour;
        if (price < ItemValuation.modConfig.badAmmoMaxValue) return ItemValuation.modConfig.badColour;
        if (price < ItemValuation.modConfig.poorAmmoMaxValue) return ItemValuation.modConfig.poorColour;
        if (price < ItemValuation.modConfig.fairAmmoMaxValue) return ItemValuation.modConfig.fairColour;
        if (price < ItemValuation.modConfig.goodAmmoMaxValue) return ItemValuation.modConfig.goodColour;
        if (price < ItemValuation.modConfig.veryGoodAmmoMaxValue) return ItemValuation.modConfig.veryGoodColour;
        return ItemValuation.modConfig.exceptionalColour;
    }

    private static addPriceToLocales(price: number, availableOnFlea: boolean, itemID: string, perSlotDescription = false): void
    {
        for (const locale in ItemValuation.localeTable)
        {
            const priceType = perSlotDescription ? "Price Per Slot:" : "Price:"
            const originalDescription = ItemValuation.originalLocaleTable[locale][`${itemID} Description`]; 
            ItemValuation.localeTable[locale][`${itemID} Description`] = `${priceType} ${ItemValuation.formatToRoubles(price)} | Flea Banned: ${availableOnFlea ? "No" : "Yes"} | Update: ${ItemValuation.updateNumber}\n\n` + originalDescription;
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
            return pluginList.includes(pluginName);
        }
        catch 
        {
            return false;
        }
    }
}

interface Config
{
    colourFleaBannedItems: boolean,
    colourNormalItems: boolean,
    colourWeapons: boolean,
    colourAmmo: boolean,
    
    badItemPerSlotMaxValue: number,
    badWeaponMaxValue: number,
    badAmmoMaxValue: number,
    badColour: string,
    
    poorItemPerSlotMaxValue: number,
    poorWeaponMaxValue: number,
    poorAmmoMaxValue: number,
    poorColour: string,

    fairItemPerSlotMaxValue: number,
    fairWeaponMaxValue: number,
    fairAmmoMaxValue: number,
    fairColour: string,

    goodItemPerSlotMaxValue: number,
    goodWeaponMaxValue: number,
    goodAmmoMaxValue: number,
    goodColour: string,

    veryGoodItemPerSlotMaxValue: number,
    veryGoodWeaponMaxValue: number,
    veryGoodAmmoMaxValue: number,
    veryGoodColour: string,

    exceptionalColour: string,
    fleaBannedColour: string,
}

export const mod = new ItemValuation();
