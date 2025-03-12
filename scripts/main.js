/**
 * BlockReGenerator - ブロック再生成システム
 * 
 * 概要:
 * このスクリプトは、破壊されたブロックを一定時間後に自動的に再生成するシステムを実装します。
 * 
 * 主な機能:
 * 1. ブロックの設定
 *    - 特定のアイテムを使用してブロックを設定
 *    - 再生成時間、ブロックタイプ、中間ブロックタイプを設定可能
 * 
 * 2. ブロックの再生成
 *    - ブロックが破壊された際に中間ブロックを設置
 *    - 設定された時間後に元のブロックを再生成
 * 
 * 3. 管理機能
 *    - クリエイティブモードでの設定削除
 *    - 中間ブロックの破壊防止
 *    - 設定の永続化（DynamicProperty使用）
 * 
 * 使用方法:
 * 1. 設定モード: スニーク + トリガーアイテム使用
 * 2. ブロック設定: トリガーアイテムで対象ブロックを使用
 * 3. 設定削除: クリエイティブモードでブロックを破壊
 * 
 * 技術的な詳細:
 * - 座標管理: 15桁のユニークIDを使用
 * - データ永続化: DynamicPropertyを使用
 * - イベント処理: beforeEvents, afterEventsを使用
 * 
 * @version 1.0.0
 * @license MIT
 */

import { world, system, GameMode } from '@minecraft/server';
import { ModalFormData } from '@minecraft/server-ui';

// システム全体で使用する定数の定義
const CONSTANTS = {
    // ブロック情報を保存する際のプロパティのプレフィックス
    PROPERTY_PREFIX: 'block:',
    // プレイヤーの設定を保存するためのキー
    SETTING_KEY: 'blockReGeneratorSetting',
    // 設定操作に使用するアイテムのID
    TRIGGER_ITEM: 'minecraft:ominous_trial_key',
    // フォームのデフォルト値
    DEFAULT_VALUES: {
        GEN_TIME: '20',
        BLOCK_TYPE: 'minecraft:diamond_ore',
        MID_BLOCK_TYPE: 'minecraft:cobblestone'
    },
    // 座標のオフセット値（負の座標を正の値に変換するため）
    COORDINATE_OFFSET: 30000000,
    // 座標の各要素の桁数
    COORDINATE_DIGITS: 5
};

/**
 * 座標からユニークなIDを生成する
 * @param {number} x - X座標（-30,000,000から30,000,000の範囲）
 * @param {number} y - Y座標（-30,000,000から30,000,000の範囲）
 * @param {number} z - Z座標（-30,000,000から30,000,000の範囲）
 * @returns {string} 座標から生成された15桁のユニークID
 *                   各座標は5桁に正規化され、連結される
 */
function getLocationId(x, y, z) {
    // 負の座標を正の値に変換
    const positiveX = x + CONSTANTS.COORDINATE_OFFSET;
    const positiveY = y + CONSTANTS.COORDINATE_OFFSET;
    const positiveZ = z + CONSTANTS.COORDINATE_OFFSET;
    
    // 各座標を指定桁数の文字列に変換して結合
    return [positiveX, positiveY, positiveZ]
        .map(coord => coord.toString().padStart(CONSTANTS.COORDINATE_DIGITS, '0').slice(-CONSTANTS.COORDINATE_DIGITS))
        .join('');
}

/**
 * DynamicPropertyの操作をラップするマネージャー
 * @namespace DynamicPropertyManager
 */
const DynamicPropertyManager = {
    /**
     * ブロックのキーを生成
     * @param {string} locationId - 位置ID（15桁の数値文字列）
     * @returns {string} プロパティキー（'block:'プレフィックス + 位置ID）
     */
    getBlockKey: (locationId) => `${CONSTANTS.PROPERTY_PREFIX}${locationId}`,
    
    /**
     * プロパティの取得と自動的なJSONパース
     * @param {string} key - プロパティキー
     * @returns {Object|null} 取得したデータ（パース済み）、エラー時はnull
     * @throws {Error} JSONパースに失敗した場合
     */
    get: (key) => {
        try {
            const value = world.getDynamicProperty(key);
            return value ? JSON.parse(value) : null;
        } catch (error) {
            console.warn(`Failed to get property ${key}:`, error);
            return null;
        }
    },
    
    /**
     * プロパティの設定と自動的なJSON文字列化
     * @param {string} key - プロパティキー
     * @param {Object} value - 保存するデータ（任意のJSONシリアライズ可能なオブジェクト）
     * @returns {boolean} 成功した場合はtrue、失敗した場合はfalse
     * @throws {Error} JSONシリアライズに失敗した場合
     */
    set: (key, value) => {
        try {
            world.setDynamicProperty(key, JSON.stringify(value));
            return true;
        } catch (error) {
            console.warn(`Failed to set property ${key}:`, error);
            return false;
        }
    },
    
    /**
     * プロパティの削除
     * @param {string} key - プロパティキー
     * @returns {boolean} 成功した場合はtrue、失敗した場合はfalse
     */
    remove: (key) => {
        try {
            world.setDynamicProperty(key, null);
            return true;
        } catch (error) {
            console.warn(`Failed to remove property ${key}:`, error);
            return false;
        }
    }
};

/**
 * ブロック情報の操作をラップするマネージャー
 * @namespace BlockManager
 */
const BlockManager = {
    /**
     * ブロック情報オブジェクトの作成
     * @param {Block} block - 対象のブロック（位置情報とディメンション情報を含む）
     * @param {Object} settings - 設定データ
     * @param {string} settings.genTime - 再生成時間（tick）
     * @param {string} settings.blockType - ブロックの種類
     * @param {string} settings.midBlockType - 中間ブロックの種類
     * @returns {Object} 初期化されたブロック情報オブジェクト
     */
    createBlockInfo: (block, settings) => ({
        location: block.location,          // ブロックの座標
        time: parseInt(settings.genTime),  // 現在の再生成までの時間
        genTime: parseInt(settings.genTime), // 設定された再生成時間
        blockType: settings.blockType,     // 元のブロックの種類
        midBlockType: settings.midBlockType, // 中間ブロックの種類
        dimensionId: block.dimension.id,   // ディメンションID
        configured: false,                 // 初期設定完了フラグ
        breaked: false                     // 破壊状態フラグ
    }),
    
    /**
     * ブロックの設置
     * @param {Dimension} dimension - 対象のディメンション
     * @param {BlockLocation} location - 設置位置（x, y, z座標を含む）
     * @param {string} blockType - ブロックタイプ（例: 'minecraft:diamond_ore'）
     * @returns {boolean} 設置に成功した場合はtrue、失敗した場合はfalse
     */
    setBlock: (dimension, location, blockType) => {
        try {
            dimension.setBlockType(location, blockType);
            return true;
        } catch (error) {
            console.warn('Failed to set block:', error);
            return false;
        }
    },
    
    /**
     * ブロック情報の有効性チェック
     * @param {Object} blockInfo - チェックするブロック情報
     * @param {Vector3} blockInfo.location - ブロックの座標
     * @param {string} blockInfo.blockType - ブロックの種類
     * @param {string} blockInfo.midBlockType - 中間ブロックの種類
     * @returns {boolean} 有効なブロック情報の場合はtrue、無効な場合はfalse
     */
    isValidBlockInfo: (blockInfo) => {
        return blockInfo && 
               blockInfo.location && 
               blockInfo.blockType && 
               blockInfo.midBlockType;
    }
};

/**
 * 設定フォームの表示と処理
 * @param {Player} player - フォームを表示するプレイヤー
 *                         プレイヤーの権限とゲームモードに応じて表示
 * @throws {Error} フォームの表示に失敗した場合
 */
function showSettingFormModal(player) {
    // フォームの作成
    const form = new ModalFormData()
        .title('BlockReGeneratorSetting')
        .textField('再生成時間（tick）', '整数を入力', CONSTANTS.DEFAULT_VALUES.GEN_TIME)
        .textField('生成ブロック', '', CONSTANTS.DEFAULT_VALUES.BLOCK_TYPE)
        .textField('中間ブロック', '', CONSTANTS.DEFAULT_VALUES.MID_BLOCK_TYPE);

    // フォームの表示と結果の処理
    form.show(player)
        .then((formData) => handleFormSubmission(player, formData))
        .catch((error) => {
            player.sendMessage('§cフォームの表示に失敗しました。');
            console.warn("Form error:", error);
        });
}

/**
 * フォームの送信結果を処理
 * @param {Player} player - フォームを送信したプレイヤー
 * @param {FormResponse} formData - フォームの送信データ
 * @param {Array<string>} formData.formValues - フォームの入力値
 *                                              [0]: 再生成時間
 *                                              [1]: ブロックタイプ
 *                                              [2]: 中間ブロックタイプ
 */
function handleFormSubmission(player, formData) {
    // フォームデータの有効性チェック
    if (!formData || !formData.formValues || formData.formValues.length < 3) {
        player.sendMessage('§cフォームの入力が不完全です。');
        return;
    }

    // 入力値の取得と検証
    const [genTime, blockType, midBlockType] = formData.formValues;
    if (!genTime || !blockType || !midBlockType) {
        player.sendMessage('§cすべての項目を入力してください。');
        return;
    }

    // 設定の保存
    const settings = { genTime, blockType, midBlockType };
    if (DynamicPropertyManager.set(CONSTANTS.SETTING_KEY, settings)) {
        player.sendMessage('§a設定を保存しました。');
    }
}

/**
 * ブロックへの設定の適用
 * @param {Block} block - 設定を適用するブロック
 *                       ブロックの位置情報とディメンション情報を含む
 * @param {Object} settings - ブロックの再生成設定
 * @param {string} settings.genTime - 再生成までの時間（tick）
 * @param {string} settings.blockType - 再生成するブロックの種類
 * @param {string} settings.midBlockType - 中間状態のブロックの種類
 * @returns {boolean} 設定の適用が成功したかどうか
 */
function settingBlock(block, settings) {
    // ブロックの位置からユニークIDを生成
    const locationId = getLocationId(block.location.x, block.location.y, block.location.z);
    const blockKey = DynamicPropertyManager.getBlockKey(locationId);
    
    // 既存の設定をチェック
    const existingBlockInfo = DynamicPropertyManager.get(blockKey);
    if (existingBlockInfo) {
        world.sendMessage('§cこのブロックは既に設定されています');
        return false;
    }
    
    // 新しい設定を適用
    const blockInfo = BlockManager.createBlockInfo(block, settings);
    return DynamicPropertyManager.set(blockKey, blockInfo);
}

/**
 * メインの処理ループ（1tickごとに実行）
 */
system.runInterval(() => {
    // すべてのプロパティIDを取得
    const dataIds = world.getDynamicPropertyIds();
    for (const dataId of dataIds) {
        // ブロック関連のプロパティのみを処理
        if (!dataId.startsWith(CONSTANTS.PROPERTY_PREFIX)) continue;
        
        // ブロック情報の取得と検証
        const blockInfo = DynamicPropertyManager.get(dataId);
        if (!blockInfo || !BlockManager.isValidBlockInfo(blockInfo)) {
            DynamicPropertyManager.remove(dataId);
            continue;
        }

        // ブロックの更新処理
        handleBlockUpdate(dataId, blockInfo);
    }
}, 1);

/**
 * ブロックの状態更新処理
 * @param {string} dataId - ブロック情報のプロパティキー
 *                         'block:' で始まるユニークな識別子
 * @param {Object} blockInfo - ブロックの状態情報
 * @param {Vector3} blockInfo.location - ブロックの座標（x, y, z）
 * @param {number} blockInfo.time - 現在の再生成までの残り時間（tick）
 * @param {number} blockInfo.genTime - 設定された再生成時間（tick）
 * @param {string} blockInfo.blockType - 元のブロックの種類（例: 'minecraft:diamond_ore'）
 * @param {string} blockInfo.midBlockType - 中間ブロックの種類（例: 'minecraft:cobblestone'）
 * @param {string} blockInfo.dimensionId - ブロックが存在するディメンションのID
 * @param {boolean} blockInfo.configured - 初期設定が完了しているかどうか
 * @param {boolean} blockInfo.breaked - ブロックが破壊状態かどうか
 */
function handleBlockUpdate(dataId, blockInfo) {
    const dimension = world.getDimension(blockInfo.dimensionId);
    
    // 初期設定時の処理
    if (!blockInfo.configured) {
        BlockManager.setBlock(dimension, blockInfo.location, blockInfo.blockType);
        blockInfo.configured = true;
        DynamicPropertyManager.set(dataId, blockInfo);
        return;
    }

    // 破壊後の再生成処理
    if (blockInfo.breaked) {
        if (blockInfo.time <= 0) {
            // 再生成時間経過後、元のブロックを設置
            BlockManager.setBlock(dimension, blockInfo.location, blockInfo.blockType);
            blockInfo.breaked = false;
            blockInfo.time = blockInfo.genTime;
        } else {
            // タイマーのカウントダウン
            blockInfo.time--;
        }
        DynamicPropertyManager.set(dataId, blockInfo);
    }
}

/**
 * ブロックとの対話イベント処理
 * @event beforeEvents.playerInteractWithBlock
 * @param {PlayerInteractWithBlockBeforeEvent} ev - イベントデータ
 * @param {Player} ev.player - 対話を行ったプレイヤー
 * @param {Block} ev.block - 対話されたブロック
 * @param {ItemStack} ev.itemStack - プレイヤーが手に持っているアイテム
 * @param {boolean} ev.isFirstEvent - 重複イベントでないことを示すフラグ
 */
world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
    const { player, block , itemStack: item, isFirstEvent} = ev;
    // 重複イベントの防止
    if(!isFirstEvent) return;

    // トリガーアイテムとブロックの確認
    // - トリガーアイテムであること
    // - 対象が空気ブロックでないこと
    // - スニーク状態でないこと
    if (item.typeId !== CONSTANTS.TRIGGER_ITEM || block.isAir || player.isSneaking) return;
    
    // 設定の取得と確認
    const settings = DynamicPropertyManager.get(CONSTANTS.SETTING_KEY);
    if (!settings) {
        player.sendMessage('§c設定が見つかりません。スニーク+使用で設定してください。');
        return;
    }
    
    // ブロックに設定を適用
    settingBlock(block, settings);
    player.sendMessage('§aブロックを設定しました。');
});

/**
 * アイテム使用イベント処理
 * @event afterEvents.itemUse
 * @param {ItemUseAfterEvent} ev - イベントデータ
 * @param {Player} ev.source - アイテムを使用したプレイヤー
 * @param {ItemStack} ev.itemStack - 使用されたアイテム
 * @description スニーク状態でトリガーアイテムを使用した際に設定画面を表示
 */
world.afterEvents.itemUse.subscribe((ev) => {
    const { source: player, itemStack: item } = ev;

    // スニーク状態でトリガーアイテムを使用した場合のみ設定画面を表示
    if (player.isSneaking && item.typeId === CONSTANTS.TRIGGER_ITEM) {
        showSettingFormModal(player);
        return;
    }
});

/**
 * ブロック破壊前のイベント処理
 * @event beforeEvents.playerBreakBlock
 * @param {PlayerBreakBlockBeforeEvent} ev - イベントデータ
 * @param {Player} ev.player - ブロックを破壊したプレイヤー
 * @param {Block} ev.block - 破壊されたブロック
 * @param {boolean} ev.cancel - イベントのキャンセルフラグ
 * @description 中間ブロックの破壊を防止する
 */
world.beforeEvents.playerBreakBlock.subscribe((ev) => {
    const { player, block } = ev;
    const locationId = getLocationId(block.location.x, block.location.y, block.location.z);
    const blockKey = DynamicPropertyManager.getBlockKey(locationId);
    
    // ブロック情報の取得
    const blockInfo = DynamicPropertyManager.get(blockKey);
    if (!blockInfo) return;
    
    // 中間ブロックの破壊を防止
    if (blockInfo.breaked && blockInfo.time > 0) {
        ev.cancel = true;
        player.sendMessage('§c再生成中のブロックは破壊できません');
        return;
    }
});

/**
 * ブロック破壊後のイベント処理
 * @event afterEvents.playerBreakBlock
 * @param {PlayerBreakBlockAfterEvent} ev - イベントデータ
 * @param {Player} ev.player - ブロックを破壊したプレイヤー
 * @param {Block} ev.block - 破壊されたブロック
 * @description 
 * - クリエイティブモード: ブロックの設定を削除
 * - サバイバルモード: 中間ブロックの設置と再生成タイマーの開始
 */
world.afterEvents.playerBreakBlock.subscribe((ev) => {
    const { player, block } = ev;
    const locationId = getLocationId(block.location.x, block.location.y, block.location.z);
    const blockKey = DynamicPropertyManager.getBlockKey(locationId);
    
    // ブロック情報の取得
    const blockInfo = DynamicPropertyManager.get(blockKey);
    if (!blockInfo) return;
    
    // クリエイティブモードの場合は設定を削除
    if (player.getGameMode() === GameMode.creative) {
        DynamicPropertyManager.remove(blockKey);
        player.sendMessage('§eクリエイティブモードでブロックの設定を削除しました');
        return;
    }
    
    // 中間ブロックの設置と状態更新
    BlockManager.setBlock(world.getDimension(blockInfo.dimensionId), 
                         blockInfo.location, 
                         blockInfo.midBlockType);
    
    blockInfo.breaked = true;
    blockInfo.time = blockInfo.genTime;
    DynamicPropertyManager.set(blockKey, blockInfo);
});