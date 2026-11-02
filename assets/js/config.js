/**
 * 唯一需要改动的配置文件。
 * 迁移到国内服务（函数计算 / EdgeOne / 自己的服务器）时，只需要改 API_BASE 一个值。
 */

/** Worker 地址。优先级：URL 参数 ?api= > localStorage > 下面的默认值 */
const fromQuery = new URLSearchParams(location.search).get('api');
const fromStorage = localStorage.getItem('cfg:api_base');

export const API_BASE = (fromQuery || fromStorage || 'https://image-report-api.xingjie-field.workers.dev').replace(/\/$/, '');

if (fromQuery) localStorage.setItem('cfg:api_base', API_BASE); // 调试用，便于记住地址

export const BRAND = {
  name: '形界 FIELD',
  slogan: 'AI 形象诊断',
  /** 对外署名：保持独立测评工具感，不放门店/地域信息 */
  byline: '形界 FIELD · AI 形象诊断',
  /** 私域引流钩子（报告页完整表述） */
  hook: '加微信领《男生脸型发型适配对照表》+ 高清版报告',
  /** 分享物料上的短钩子（字数受限，不要带「扫码」二字，代码会按有无二维码自动加） */
  hookShort: '领资料',
  /** 私域微信号（可选）。填了会在报告页与无二维码时展示 */
  wechat: '',
  /** 二维码图片地址（可选）。建议放个人微信/公众号/群活码 */
  qr: '',
  /** 分享卡片主色 */
  navy: '#1B2C4A',
  blue: '#35608F',
  blueSoft: '#E8EFF7',
  warm: '#B4754A',
  ink: '#15181D',
  ink2: '#4A515B',
  ink3: '#8D949E',
  bg: '#F7F6F3',
  font: '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
};

/** 色名 → 实际颜色（用于分享卡上的色块） */
export const COLOR_MAP = {
  藏青: '#1B2C4A', 海军蓝: '#1B2C4A', 深蓝: '#1B2C4A',
  炭灰: '#3B3F45', 深灰: '#3B3F45', 灰色: '#5F5E5A',
  米白: '#F0EBE1', 燕麦: '#E3D9C6', 驼色: '#B58A5A', 卡其: '#B79A6A',
  灰蓝: '#7A93AF', 雾霾蓝: '#7A93AF',
  橄榄绿: '#6B7042', 军绿: '#5C6247',
  焦糖: '#A9622F', 酒红: '#77283C', 勃艮第: '#77283C',
  黄铜: '#A98A4B', 奶油: '#F2EBDD', 白: '#F6F4F0', 黑色: '#17181A',
  黑: '#17181A', 浅灰: '#D9D7D0', 深棕: '#5B3A22', 棕色: '#7A5230',
};
