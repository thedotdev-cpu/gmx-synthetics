import { expect } from "chai";
import { setNextBlockBaseFeePerGas } from "@nomicfoundation/hardhat-network-helpers";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { OrderType, DecreasePositionSwapType, getOrderKeys } from "../../utils/order";
import * as keys from "../../utils/keys";

describe("AUDIT: subaccount WNT auto-top-up double charge", () => {
  it("reimburses an execution fee that the principal already funded as WNT collateral", async () => {
    const fixture = await deployFixture();
    const { user0: principal, user1: subaccount } = fixture.accounts;
    const { dataStore, router, subaccountRouter, orderVault, reader, ethUsdMarket, wnt } = fixture.contracts;

    await dataStore.setUint(keys.ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR, decimalToFloat(1));
    await setNextBlockBaseFeePerGas(expandDecimals(1, 9));

    await subaccountRouter.connect(principal).addSubaccount(subaccount.address);
    await subaccountRouter
      .connect(principal)
      .setMaxAllowedSubaccountActionCount(subaccount.address, keys.SUBACCOUNT_ORDER_ACTION, 1);
    await subaccountRouter
      .connect(principal)
      .setSubaccountExpiresAt(subaccount.address, keys.SUBACCOUNT_ORDER_ACTION, 9_999_999_999);
    await subaccountRouter
      .connect(principal)
      .setSubaccountAutoTopUpAmount(subaccount.address, expandDecimals(2, 17));

    const transferredFromPrincipal = expandDecimals(1, 17); // 0.1 WNT
    const executionFee = expandDecimals(5, 16); // 0.05 WNT

    await wnt.mint(principal.address, expandDecimals(1, 18));
    await wnt.connect(principal).approve(router.address, expandDecimals(1, 18));

    const params = {
      addresses: {
        receiver: principal.address,
        cancellationReceiver: principal.address,
        callbackContract: ethers.constants.AddressZero,
        uiFeeReceiver: ethers.constants.AddressZero,
        market: ethUsdMarket.marketToken,
        initialCollateralToken: wnt.address,
        swapPath: [],
      },
      numbers: {
        sizeDeltaUsd: decimalToFloat(1000),
        initialCollateralDeltaAmount: transferredFromPrincipal,
        triggerPrice: decimalToFloat(6000),
        acceptablePrice: decimalToFloat(6000),
        executionFee,
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

    const principalBalanceBefore = await wnt.balanceOf(principal.address);
    const subaccountNativeBefore = await ethers.provider.getBalance(subaccount.address);

    const tx = await subaccountRouter.connect(subaccount).createOrder(principal.address, params);
    await tx.wait();

    const principalBalanceAfter = await wnt.balanceOf(principal.address);
    const principalLoss = principalBalanceBefore.sub(principalBalanceAfter);
    const topUpCharged = principalLoss.sub(transferredFromPrincipal);

    // The principal funds the full 0.1 WNT transfer. OrderUtils carves 0.05 WNT out
    // of it as the execution fee, yet _autoTopUpSubaccount charges the principal for
    // the same 0.05 WNT again, plus measured gas, and sends that value to the subaccount.
    expect(topUpCharged).gt(executionFee);
    expect(principalLoss).gt(transferredFromPrincipal.add(executionFee));

    const subaccountNativeAfter = await ethers.provider.getBalance(subaccount.address);
    expect(subaccountNativeAfter).gt(subaccountNativeBefore.add(executionFee.mul(9).div(10)));

    const [orderKey] = await getOrderKeys(dataStore, 0, 1);
    const order = await reader.getOrder(dataStore.address, orderKey);
    expect(order.numbers.executionFee).eq(executionFee);
    expect(order.numbers.initialCollateralDeltaAmount).eq(transferredFromPrincipal.sub(executionFee));
    expect(await wnt.balanceOf(orderVault.address)).eq(transferredFromPrincipal);
  });
});
