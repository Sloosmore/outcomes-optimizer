import { getSqlClient } from '@skill-networks/database/client'
import { ResourcesService } from '@skill-networks/database/services'
import { MetricsService } from '@skill-networks/database/services'
import { ProcessesService } from '@skill-networks/database/services'
import { EventsService } from '@skill-networks/database/services'
import { MessagesService } from '@skill-networks/database/services'
import { ChatsService } from '@skill-networks/database/services'
import { EpochResultsService } from '@skill-networks/database/services'

let _services: ReturnType<typeof createServices> | undefined

function createServices() {
  const sql = getSqlClient()
  return {
    sql,
    resources: new ResourcesService(sql),
    metrics: new MetricsService(sql),
    processes: new ProcessesService(sql),
    events: new EventsService(sql),
    messages: new MessagesService(sql),
    chats: new ChatsService(sql),
    epochResults: new EpochResultsService(sql),
  }
}

export function getServices() {
  if (!_services) _services = createServices()
  return _services
}
