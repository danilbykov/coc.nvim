import { BaseLanguageClient, DynamicFeature, RegistrationData } from '../language-client/client'
import {
  ClientCapabilities, RequestType, NotificationType, RPCMessageType, ServerCapabilities, Emitter,
  ExecuteCommandRequest, ExecuteCommandParams, Location, TextDocumentPositionParams, TextDocument, Position
} from 'vscode-languageserver-protocol'
import {
  TreeViewChildrenParams, TreeViewChildrenResult, TreeViewDidChangeParams,
  TreeViewNodeCollapseDidChangeParams, TreeViewVisibilityDidChangeParams, TreeViewNode,
  MetalsClientCommandParams,
  MetalsTreeRevealResult
} from './domain'
import { commands, workspace } from '..'
import languages from '../languages'
import { TreeViewProvider } from './provider'
import * as cv from './../language-client/utils/converter'
import { wait } from '../util'

interface TreeViewParams {
}

interface TreeViewOptions {
}

export class TreeViewFeature implements DynamicFeature<TreeViewParams> {

  private requestType =
    new RequestType<TreeViewParams, any, void, TreeViewOptions>('metals/treeView')
  private treeViewChildrenParamsType =
    new RequestType<TreeViewChildrenParams, TreeViewChildrenResult, void, void>('metals/treeViewChildren')
  private treeViewRevealType =
    new RequestType<TextDocumentPositionParams, MetalsTreeRevealResult, void, void>('metals/treeViewReveal')

  private treeViewDidChangeType =
    new NotificationType<TreeViewDidChangeParams, void>('metals/treeViewDidChange')
  private metalsClientCommandType =
    new NotificationType<MetalsClientCommandParams, void>('metals/executeClientCommand')

  private treeViewVisibilityChangedType =
    new NotificationType<TreeViewVisibilityDidChangeParams, void>('metals/treeViewVisibilityDidChange')
  private treeViewNodeCollapseChangedType =
    new NotificationType<TreeViewNodeCollapseDidChangeParams, void>('metals/treeViewNodeCollapseDidChange')

  private viewUpdaters: Map<String, Emitter<TreeViewNode>> = new Map()

  constructor(private _client: BaseLanguageClient) { }

  public get messages(): RPCMessageType {
    return this.requestType
  }

  public fillClientCapabilities(capabilities: ClientCapabilities): void {
    if (capabilities.experimental == null) {
      capabilities.experimental = {}
    }
    capabilities.experimental.treeViewProvider = true
  }

  public initialize(
    capabilities: ServerCapabilities,
  ): void {
    if (!capabilities.experimental!.treeViewProvider) return
    const client = this._client

    client.onNotification(this.treeViewDidChangeType, message => {
      message.nodes.forEach(node => {
        const viewId = node.viewId
        const mbViewUpdater = this.viewUpdaters.get(viewId)
        if (mbViewUpdater === undefined) {
          const updatesEmitter = new Emitter<TreeViewNode>()
          const treeViewProvider: TreeViewProvider = {
            viewId,

            updatedNodes: updatesEmitter.event,

            loadNodeChildren: (
              parentNode?: string
            ): Promise<TreeViewNode[]> => {
              const result = client
                .sendRequest(this.treeViewChildrenParamsType, { viewId, nodeUri: parentNode })
                .then(r => r.nodes)
              return Promise.resolve(result)
            },

            loadParentInfo: (
              document: TextDocument,
              position: Position
            ): Promise<MetalsTreeRevealResult> => {
              const tweakedPosition = {line: position.line + 1, character: position.character}
              const arg = cv.asTextDocumentPositionParams(document, tweakedPosition)
              return Promise.resolve(client.sendRequest(this.treeViewRevealType, arg))
            },

            sendTreeViewVisibilityNotification: (
              visible: boolean
            ): void => {
              client.sendNotification(this.treeViewVisibilityChangedType, { viewId, visible })
            },

            sendTreeNodeVisibilityNotification: (
              childNode: string,
              collapsed: boolean
            ): void => {
              client.sendNotification(this.treeViewNodeCollapseChangedType, { viewId, nodeUri: childNode, collapsed })
            }
          }
          languages.registerTreeViewsProvider(treeViewProvider)
          this.viewUpdaters.set(viewId, updatesEmitter)
        } else {
          mbViewUpdater.fire(node)
        }
      })
    })

    client.onNotification(this.metalsClientCommandType, async message => {
      switch (message.command) {
        case "metals-goto-location":
          const args = message.arguments
          let location: Location
          if (Location.is(args)) {
            location = args// as Location
          } else if (Array.isArray(args)) {
            if (args.length > 0) {
              location = args[0]
            } else {
              workspace.showMessage("No Locations found", 'error')
            }
          } else {
            workspace.showMessage("No Locations found", 'error')
          }

          const nvim = workspace.nvim
          const tabpage = await nvim.tabpage
          const allViewNames = ((await tabpage.getVar('alltreeviews')) as string) || ""
          const allTreeViews = await Promise.all(allViewNames.split(",").map(viewName => tabpage.getVar(viewName)))
          const windows = await tabpage.windows
          const mbWindow = windows.find(window => allTreeViews.find(wId => window.id === wId) === undefined)
          if (mbWindow === undefined) {
            await nvim.command('silent botright vertical new')
          } else {
            await nvim.call('win_gotoid', mbWindow.id)
          }
          // It seems this line fixes weird issue with "returned a response with an unknown
          // request id" after executing commands several times.
          await wait(10)
          await workspace.jumpTo(location.uri, location.range.start)
        default:
      }
    })

    commands.registerCommand("metals.goto", (...args: any[]) => {
      let params: ExecuteCommandParams = {
        command: "metals.goto",
        arguments: args
      }
      return client
        .sendRequest(ExecuteCommandRequest.type, params)
        .then(undefined, error => {
          client.logFailedRequest(ExecuteCommandRequest.type, error)
        })
    }, null, true)
  }

  /* tslint:disable:no-empty */
  public register(_message: RPCMessageType, _data: RegistrationData<TreeViewParams>): void { }

  /* tslint:disable:no-empty */
  public unregister(_: string): void { }

  /* tslint:disable:no-empty */
  public dispose(): void {}
}
