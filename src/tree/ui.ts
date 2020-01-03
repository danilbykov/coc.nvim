import { Neovim, Buffer, Window } from '@chemzqm/neovim'
import { TextDocument, Position } from 'vscode-languageserver-types'

import { commands, workspace } from '..'
import { WorkspaceConfiguration } from '../types'
import { Node, NodeView, TreeModel, TreeModelUpdate } from '../provider/TreeModelManager'
import { sequence } from '../util'

const logger = require('../util/logger')('treeui')

export interface TreeViewDescription {
  name: string
  size: number
  expanded: string[][]
}

interface WindowWithOffsets {
  window: Window
  curLine: number
  topLine?: number
}

export class TreeView {

  private firstUpdate = true
  private closed = "▸"
  private open = "▾"
  private eventQueue: Promise<any> = Promise.resolve(1)
  private highlightPlaceId = 0
  private lineToSignId: Map<number, number> = new Map()

  constructor(
    private nvim: Neovim,
    private config: WorkspaceConfiguration,
    private buffer: Buffer,
    private model: TreeModel
  ) { }

  public async init(): Promise<void> {
    await this.nvim.command(`silent file ${this.model.viewId}`)
    const commandPrefix = "nnoremap <buffer> <silent>"
    function cocAction(param: string): string { return `:call CocAction("treeViews", "${param}")<CR>` }
    await this.nvim.command(`${commandPrefix} ${this.config.get<string>("toggleNode")} ${cocAction("ToggleNode")}`)
    await this.nvim.command(`${commandPrefix} ${this.config.get<string>("gotoParentNode")} ${cocAction("ParentNode")}`)
    await this.nvim.command(`${commandPrefix} ${this.config.get<string>("gotoFirstChild")} ${cocAction("FirstSibling")}`)
    await this.nvim.command(`${commandPrefix} ${this.config.get<string>("gotoLastChild")} ${cocAction("LastSibling")}`)
    await this.nvim.command(`${commandPrefix} ${this.config.get<string>("gotoPrevSibling")} ${cocAction("PrevSibling")}`)
    await this.nvim.command(`${commandPrefix} ${this.config.get<string>("gotoLastSibling")} ${cocAction("NextSibling")}`)
    await this.nvim.command(`${commandPrefix} ${this.config.get<string>("executeCommand")} ${cocAction("ExecuteCommand")}`)

    await this.nvim.command("setlocal nonumber norelativenumber nobuflisted nowrap noswapfile")// cursorline")
    await this.nvim.command("setlocal statusline=%f buftype=nofile bufhidden=hide")

    this.model.updateEvents(ev => this.handleModelUpdates(ev))

    this.model.show()

    const viewsConfigs = this.config.get<TreeViewDescription[]>("initialViews")
    await this.model.rootNode.expand()
    const mbDesc = viewsConfigs.find(c => c.name === this.model.viewId)
    if (mbDesc !== undefined) {
      await Promise.all(mbDesc.expanded.map(parents => this.model.revealByParents(parents.concat(""))))
      await this.nvim.call('coc#util#jumpTo', [0, 1])
    }
  }

  public get bufferId(): number {
    return this.buffer.id
  }

  public handleModelUpdates(ev0: TreeModelUpdate): void {
    const isRoot = ev0.root.underlying.nodeUri === undefined
    // hide root in trees
    const ev = isRoot
      ? {root: ev0.payload[1], length: ev0.length - 1, payload: ev0.payload.slice(1), focusEvent: ev0.focusEvent}
      : ev0
    this.eventQueue = this.eventQueue.then(async _ => {
      const offset = await this.model.findNodeOffset(ev.root) - 1
      if (offset === undefined) return

      const tabpage = await this.nvim.tabpage
      const allWindows = await this.nvim.windows
      const tabpageWindows = await tabpage.windows
      const windowIds = (await this.nvim.call("win_findbuf", this.bufferId)) as number[]
      const bufferWindows = allWindows.filter(window => windowIds.indexOf(window.id) != -1)
      if (ev.focusEvent) {
        logger.debug(`Focus event. Root: ${ev.root.underlying.nodeUri}, offset: ${offset}.`)
        await sequence(bufferWindows, async w => {
          const needRedraw = tabpageWindows.find(tabwindow => tabwindow.id === w.id) !== undefined
          if (needRedraw) {
            await this.nvim.call("win_gotoid", [w.id])
            await this.nvim.call("coc#util#jumpTo2", [1, offset + 1, true])
          }
        })
      } else {
        const payload = ev.payload.map(n => n.underlying.nodeUri).join(",")
        logger.debug(`Update event. Root: ${ev.root.underlying.nodeUri}, length: ${ev.length}, payload: ${payload}.`)
        await this.modifyBuffer(async () => {
          const offsets = await sequence(bufferWindows, async window => {
            const cursor = await window.cursor
            if (workspace.isVim && tabpageWindows.find(w => w.id === window.id) !== undefined) {
              const raw = await this.nvim.call("win_execute", [window.id, 'echo line(".").":".line("w0")']) as string
              const lines = raw.split(':').map(str => parseInt(str, 10))
              return {window, curLine: lines[0], topLine: lines[1]} as WindowWithOffsets
            } else {
              return {window, curLine: cursor[0], topLine: undefined} as WindowWithOffsets
            }
          })
          await this.removeRows(offset, offset + ev.length)
          await this.insertRows(offset, ev.payload)
          await sequence(offsets, async ({window, curLine, topLine}) => {
            if (topLine !== undefined) {
              await this.nvim.call('win_execute', [window.id, `call coc#util#jumpTo2(${topLine}, ${curLine}, v:true)`])
            } else {
              await window.setCursor([curLine, 1])
            }
          })
          if (this.firstUpdate) {
            this.firstUpdate = false
            await this.buffer.remove(ev.payload.length, ev.payload.length + 1)
          }
        })
      }
    })
  }

  private async removeRows(from: number, to: number): Promise<void> {
    const unplaceList = []
    for (let i: number = from; i < to; i++) {
      const mbPlaceId = this.lineToSignId.get(i + 1)
      if (mbPlaceId !== undefined) {
        unplaceList.push({id: mbPlaceId, buffer: this.bufferId})
        this.lineToSignId.delete(i)
      }
    }
    await Promise.all(unplaceList.map(highlightPlace => {
      return this.nvim.call("sign_unplace", ['', highlightPlace])
    }))
    await this.buffer.remove(from, to)
  }

  private async insertRows(offset: number, nodes: NodeView[]): Promise<void> {
    await this.buffer.insert(this.makeRows(nodes), offset)
    await Promise.all(nodes.map((node, idx) => {
      let highlightSchema: string | undefined
      switch (node.underlying.icon) {
        case "trait":
          highlightSchema = "TvpTrait"
          break
        case "class":
          highlightSchema = "TvpClass"
          break
        case "object":
          highlightSchema = "TvpObject"
          break
        case "method":
          highlightSchema = "TvpMethod"
          break
        case "val":
          highlightSchema = "TvpVal"
          break
        default:
          highlightSchema = undefined
      }
      if (highlightSchema !== undefined) {
        const placeId = this.highlightPlaceId++
        const line = offset + idx + 1
        this.lineToSignId.set(line, placeId)
        return this.nvim.call("sign_place", [placeId, '', highlightSchema, this.bufferId, {lnum: line}])
      } else {
        return undefined
      }
    }))
  }

  public async toggleTreeViewNode(): Promise<void> {
    const node = await this.nodeUnderCursor()
    if (node === undefined || !node.expandable()) return
    return (node.isExpanded() ? node.collapse() : node.expand()).then(_ => undefined)
  }

  public async gotoParentNode(): Promise<void> {
    const node = await this.nodeUnderCursor()
    if (node === undefined) return
    const parent = await this.model.findParentNode(node)
    if (parent === undefined) return
    const offset = await this.model.findNodeOffset(parent.makeView())
    if (offset === undefined) return
    await this.nvim.call('coc#util#jumpTo', [offset - 1, 1])
  }

  public async gotoEdgeNode(first: boolean): Promise<void> {
    const node = await this.nodeUnderCursor()
    if (node === undefined) return
    const parent = await this.model.findParentNode(node)
    if (parent === undefined) return
    const children = await parent.getChildren()
    if (children.length > 0) {
      const node = first ? children[0] : children[children.length - 1]
      const offset = await this.model.findNodeOffset(node.makeView())
      if (offset === undefined) return
      await this.nvim.call('coc#util#jumpTo', [offset - 1, 1])
    }
  }

  public async gotoNeighboringSibling(prev: boolean): Promise<void> {
    const node = await this.nodeUnderCursor()
    if (node === undefined) return
    const parent = await this.model.findParentNode(node)
    if (parent === undefined) return
    const children = await parent.getChildren()
    const childIdx = children.findIndex(child => child.viewNode.nodeUri === node.viewNode.nodeUri)
    let targetNode
    if (prev && childIdx > 0) {
      targetNode = children[childIdx - 1]
    } else if (!prev && childIdx + 1 < children.length) {
      targetNode = children[childIdx + 1]
    } else {
      targetNode = undefined
    }
    if (targetNode === undefined) return
    const offset = await this.model.findNodeOffset(targetNode.makeView())
    if (offset === undefined) return
    await this.nvim.call('coc#util#jumpTo', [offset - 1, 1])
  }

  public async executeCommand(): Promise<void> {
    const node = await this.nodeUnderCursor()
    if (node === undefined) return
    const command = node.viewNode.command
    if (command === undefined) return
    if (command.arguments !== undefined) {
      return commands.executeCommand(command.command, ...command.arguments)
    } else {
      return commands.executeCommand(command.command)
    }
  }

  public async revealDocInTreeView(textDocument: TextDocument, position: Position): Promise<Node | undefined> {
    return this.model.revealDocument(textDocument, position)
  }

  private makeRows(nodes: NodeView[]): string[] {
    return nodes.map(child => {
      let icon: string
      if (child.expandable) {
        icon = (child.expanded ? this.open : this.closed) + " "
      } else {
        icon = "  "
      }

      return "  ".repeat(child.level - 1) + icon + child.underlying.label
    })
  }

  private async nodeUnderCursor(): Promise<Node | undefined> {
    const curLine = (await this.nvim.eval('coc#util#cursor()') as [number, number])[0]
    return this.model.findNodeWithOffset(curLine + 1)
  }

  private modifyBuffer<X>(action: () => Promise<X>): Promise<X> {
    return this.buffer.setOption('readonly', false)
      .then(_ => this.buffer.setOption('modifiable', true))
      .then(_ => {
        return action()
          .finally(() => {
            return this.buffer.setOption('modifiable', false)
              .then(_ => this.buffer.setOption('readonly', true))
          })
      })
  }
}
