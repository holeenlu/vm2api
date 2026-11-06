/**
 * Gateway 事实直读的模式（设计第 19 节）：Worker 在能力描述里报告 facts=off|shadow|primary。
 * primary 时 Worker 从控制面数据库读取账号的配置与凭据，控制面不再向它推送投影（PATCH、导入），
 * 只从它导出并收录凭据（刷新轮换、授权完成）。G4 删除投影后这个判断随之删除。
 */
export function factsPrimary(capabilities) {
  return capabilities?.facts === 'primary'
}
