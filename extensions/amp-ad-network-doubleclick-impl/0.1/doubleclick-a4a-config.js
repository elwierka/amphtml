/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Because AdSense and DoubleClick are both operated by Google and their A4A
// implementations share some behavior in common, part of the logic for this
// implementation is located in the ads/google/a4a directory rather than here.
// Most other ad networks will want to put their A4A code entirely in the
// extensions/amp-ad-network-${NETWORK_NAME}-impl directory.

import {
  MANUAL_EXPERIMENT_ID,
  extractUrlExperimentId,
  addExperimentIdToElement,
} from '../../../ads/google/a4a/traffic-experiments';
import {supportsNativeCrypto} from '../../../ads/google/a4a/utils';
import {
  /* eslint no-unused-vars: 0 */ ExperimentInfo,
  getExperimentBranch,
  forceExperimentBranch,
  randomlySelectUnsetExperiments,
} from '../../../src/experiments';
import {getMode} from '../../../src/mode';
import {dev} from '../../../src/log';

/** @const {string} */
export const DOUBLECLICK_A4A_EXPERIMENT_NAME = 'expDoubleclickA4A';

/** @const {string} */
export const DFP_CANONICAL_FF_EXPERIMENT_NAME = 'expDfpCanonicalFf';

/** @const {string} */
export const DOUBLECLICK_UNCONDITIONED_EXPERIMENT_NAME =
    'expUnconditionedDoubleclick';

/** @type {string} */
const TAG = 'amp-ad-network-doubleclick-impl';

/** @const @enum{string} */
export const DOUBLECLICK_EXPERIMENT_FEATURE = {
  HOLDBACK_EXTERNAL_CONTROL: '21060726',
  HOLDBACK_EXTERNAL: '21060727',
  DELAYED_REQUEST_CONTROL: '21060728',
  DELAYED_REQUEST: '21060729',
  SRA_CONTROL: '117152666',
  SRA: '117152667',
  HOLDBACK_INTERNAL_CONTROL: '2092613',
  HOLDBACK_INTERNAL: '2092614',
  CANONICAL_CONTROL: '21060932',
  CANONICAL_EXPERIMENT: '21060933',
  CACHE_EXTENSION_INJECTION_CONTROL: '21060955',
  CACHE_EXTENSION_INJECTION_EXP: '21060956',
  IDENTITY_CONTROL: '21060937',
  IDENTITY_EXPERIMENT: '21060938',
  UNCONDITIONED_FF_CONTROL: '21061145',
  UNCONDITIONED_FF_EXPERIMENT: '21061146',
};

export const DOUBLECLICK_UNCONDITIONED_EXPERIMENTS = {
  FF_CANONICAL_CTL: '21061145',
  FF_CANONICAL_EXP: '21061146',
}

/** @const @type {!Object<string,?string>} */
export const URL_EXPERIMENT_MAPPING = {
  '-1': MANUAL_EXPERIMENT_ID,
  '0': null,
  // Holdback
  '1': DOUBLECLICK_EXPERIMENT_FEATURE.HOLDBACK_EXTERNAL_CONTROL,
  '2': DOUBLECLICK_EXPERIMENT_FEATURE.HOLDBACK_EXTERNAL,
  // Delay Request
  '3': DOUBLECLICK_EXPERIMENT_FEATURE.DELAYED_REQUEST_CONTROL,
  '4': DOUBLECLICK_EXPERIMENT_FEATURE.DELAYED_REQUEST,
  // Identity
  '5': DOUBLECLICK_EXPERIMENT_FEATURE.IDENTITY_CONTROL,
  '6': DOUBLECLICK_EXPERIMENT_FEATURE.IDENTITY_EXPERIMENT,
  // SRA
  '7': DOUBLECLICK_EXPERIMENT_FEATURE.SRA_CONTROL,
  '8': DOUBLECLICK_EXPERIMENT_FEATURE.SRA,
  // AMP Cache extension injection
  '9': DOUBLECLICK_EXPERIMENT_FEATURE.CACHE_EXTENSION_INJECTION_CONTROL,
  '10': DOUBLECLICK_EXPERIMENT_FEATURE.CACHE_EXTENSION_INJECTION_EXP,
};

/** @const {string} */
export const BETA_ATTRIBUTE = 'data-use-beta-a4a-implementation';

/** @const {string} */
export const BETA_EXPERIMENT_ID = '2077831';

/**
 * Class for checking whether a page/element is eligible for Fast Fetch.
 * Singleton class.
 * @visibleForTesting
 */
export class DoubleclickA4aEligibility {

  constructor() {
    this.activeExperiments_ = {};
  }
  /**
   * Returns whether win supports native crypto. Is just a wrapper around
   * supportsNativeCrypto, but this way we can mock out for testing.
   * @param {!Window} win
   * @return {boolean}
   */
  supportsCrypto(win) {
    return supportsNativeCrypto(win);
  }

  /**
   * Returns whether we are running on the AMP CDN.
   * @param {!Window} win
   * @return {boolean}
   */
  isCdnProxy(win) {
    const googleCdnProxyRegex =
        /^https:\/\/([a-zA-Z0-9_-]+\.)?cdn\.ampproject\.org((\/.*)|($))+/;
    return googleCdnProxyRegex.test(win.location.origin);
  }

  /**
   * Attempts to select into Fast Fetch
   * @param {!Window} win
   * @param {!Element} element
   * @private
   * @return {?string}
   */
  unconditionedSelection_(win, element) {
    const experimentId = this.maybeSelectExperiment(win, element, [
      DOUBLECLICK_UNCONDITIONED_EXPERIMENTS.FF_CANONICAL_CTL,
      DOUBLECLICK_UNCONDITIONED_EXPERIMENTS.FF_CANONICAL_EXP,
    ], DOUBLECLICK_UNCONDITIONED_EXPERIMENT_NAME);
    if (experimentId) {
      addExperimentIdToElement(experimentId, element);
      forceExperimentBranch(
          win, DOUBLECLICK_UNCONDITIONED_EXPERIMENT_NAME, experimentId);
      this.activeExperiments_[experimentId] = true;
    }
  }

  selectA4aExperiments(win, element, useRemoteHtml) {
    this.unconditionedSelection_(win, element);
    const urlExperimentId = extractUrlExperimentId(win, element);
    const isFastFetchEligible =
          !((useRemoteHtml && !element.getAttribute('rtc-config')) ||
            'useSameDomainRenderingUntilDeprecated' in element.dataset ||
            element.hasAttribute('useSameDomainRenderingUntilDeprecated'));
    const isCdnProxy = this.isCdnProxy(win);
    const isDevMode = (getMode(win).localDev || getMode(win).test);
    const hasBetaAttribute = element.hasAttribute(BETA_ATTRIBUTE);
    /**
     * Definition of A4A experiments. For each experiment, if forceExperimentBranch is
     * provided, then if the diversion criteria passes, we force on that experiment.
     * If experimentBranchIds is provided, then if the diversionCriteria passes, we
     * attempt to randomly select into one of the provided experiment branch IDs.
     */
    const experiments = [
      /************************** MANUAL EXPERIMENT ***************************/
      {forceExperimentId: MANUAL_EXPERIMENT_ID,
       experimentName: DFP_CANONICAL_FF_EXPERIMENT_NAME,
       diversionCriteria: () => {
         return isFastFetchEligible && !isCdnProxy && urlExperimentId == -1
             && isDevMode;
       }},
      /****************** CANONICAL FAST FETCH EXPERIMENT *********************/
      {experimentBranchIds: [DOUBLECLICK_EXPERIMENT_FEATURE.CANONICAL_CONTROL,
                             DOUBLECLICK_EXPERIMENT_FEATURE.CANONICAL_EXPERIMENT],
       experimentName: DFP_CANONICAL_FF_EXPERIMENT_NAME,
       diversionCriteria: () => {
         return isFastFetchEligible && !isCdnProxy && (urlExperimentId != -1
                                                       || !isDevMode);
       }},
      /******************* HOLDBACK INTERNAL EXPERIMENT ***********************/
      {experimentBranchIds: [DOUBLECLICK_EXPERIMENT_FEATURE.HOLDBACK_INTERNAL_CONTROL,
                             DOUBLECLICK_EXPERIMENT_FEATURE.HOLDBACK_INTERNAL],
       experimentName: DOUBLECLICK_A4A_EXPERIMENT_NAME,
       diversionCriteria: () => {
         return isFastFetchEligible && isCdnProxy && urlExperimentId == undefined && !hasBetaAttribute;
       }
      },
      /****************** URL EXPERIMENT SELECTION ****************************/
      {forceExperimentId: urlExperimentId ? URL_EXPERIMENT_MAPPING[urlExperimentId] : null,
       experimentName: DOUBLECLICK_A4A_EXPERIMENT_NAME,
       diversionCriteria: () => {
         return isFastFetchEligible && isCdnProxy && urlExperimentId != undefined && !hasBetaAttribute;
       }
      },
      /***************** BETA EXPERIMENT SELECTION ****************************/
      {forceExperimentId: BETA_EXPERIMENT_ID,
       experimentName: DOUBLECLICK_A4A_EXPERIMENT_NAME,
       diversionCriteria: () => {
         return isFastFetchEligible && isCdnProxy && hasBetaAttribute;
       }
      },
    ];

    // Now select into conditioned where if unconditioned was set, it takes precedence.
    let experimentId;
    experiments.forEach(experiment => {
      if (experiment.diversionCriteria()) {
        experimentId = experiment.forceExperimentId || this.maybeSelectExperiment(
            win, element, experiment.experimentBranchIds, experiment.experimentName)
        if (!!experimentId) {
          addExperimentIdToElement(experimentId, element);
          forceExperimentBranch(win, DOUBLECLICK_A4A_EXPERIMENT_NAME, experimentId);
          this.activeExperiments_[experimentId] = true;
        }
      }
    });
  }

  shouldUseFastFetch(win, element, useRemoteHtml) {
    const isFastFetchEligible =
          !((useRemoteHtml && !element.getAttribute('rtc-config')) ||
            'useSameDomainRenderingUntilDeprecated' in element.dataset ||
            element.hasAttribute('useSameDomainRenderingUntilDeprecated'));
    const fastFetchIneligibleExperiments = [
      DOUBLECLICK_EXPERIMENT_FEATURE.HOLDBACK_EXTERNAL,
      DOUBLECLICK_EXPERIMENT_FEATURE.HOLDBACK_INTERNAL,
      DOUBLECLICK_EXPERIMENT_FEATURE.CANONICAL_CONTROL,
      DOUBLECLICK_EXPERIMENT_FEATURE.UNCONDITIONED_FF_CANONICAL_CTL
    ];
    const urlExperimentId = extractUrlExperimentId(win, element);
    const fastFetchPredicates = {};
    fastFetchPredicates[
      DOUBLECLICK_EXPERIMENT_FEATURE.UNCONDITIONED_FF_CANONICAL_EXP] = () => {
        return isFastFetchEligible && !this.isCdnProxy(win) &&
            !(urlExperimentId == -1 && (getMode(win).localDev || getMode(win).test))
            && !this.supportsCrypto(win);
      };
    Object.keys(this.activeExperiments_).forEach(experimentId => {
      if (fastFetchIneligibleExperiments.includes(experimentId) ||
          (fastFetchPredicates[experimentId] && !fastFetchPredicates[experimentId]())) {
        return false;
      }
    });
    console.log(this.activeExperiments_);
    return isFastFetchEligible && this.isCdnProxy(win);
  }

  /** Whether Fast Fetch is enabled
   * @param {!Window} win
   * @param {!Element} element
   * @param {!boolean} useRemoteHtml
   * @return {boolean}
   */
  isA4aEnabled(win, element, useRemoteHtml) {
    this.selectA4aExperiments(win, element, useRemoteHtml);
    return this.shouldUseFastFetch(win, element, useRemoteHtml);
  }

  /**
   * @param {!Window} win
   * @param {!Element} element
   * @param {!Array<string>} selectionBranches
   * @param {!string} experimentName}
   * @return {?string} Experiment branch ID or null if not selected.
   * @visibleForTesting
   */
  maybeSelectExperiment(win, element, selectionBranches, experimentName) {
    const experimentInfoMap =
        /** @type {!Object<string, !ExperimentInfo>} */ ({});
    experimentInfoMap[experimentName] = {
      isTrafficEligible: () => true,
      branches: selectionBranches,
    };
    randomlySelectUnsetExperiments(win, experimentInfoMap);
    return getExperimentBranch(win, experimentName);
  }
}

/** @const {!DoubleclickA4aEligibility} */
const singleton = new DoubleclickA4aEligibility();

/**
 * @param {!Window} win
 * @param {!Element} element
 * @param {!boolean} useRemoteHtml
 * @returns {boolean}
 */
export function doubleclickIsA4AEnabled(win, element, useRemoteHtml) {
  return singleton.isA4aEnabled(win, element, useRemoteHtml);
}

/**
 * @param {!Window} win
 * @param {!DOUBLECLICK_EXPERIMENT_FEATURE} feature
 * @param {string=} opt_experimentName
 * @return {boolean} whether feature is enabled
 */
export function experimentFeatureEnabled(win, feature, opt_experimentName) {
  const experimentName = opt_experimentName || DOUBLECLICK_A4A_EXPERIMENT_NAME;
  return getExperimentBranch(win, experimentName) == feature;
}
