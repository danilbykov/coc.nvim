import { Buffer, NeovimClient as Neovim } from '@chemzqm/neovim'
import { Disposable, Emitter } from 'vscode-jsonrpc'
import { TextDocument, Position } from 'vscode-languageserver-types'

import Manager, { ProviderItem } from './manager'
import { TreeViewProvider } from '../tree/provider'
import { TreeViewNode } from '../tree/domain'
import { groupBy } from '../util/array'
import services from '../services'

export interface NodeView {
  underlying: TreeViewNode
  level: number
  expandable: boolean
  expanded: boolean
}

export interface TreeModelUpdate {
  root: NodeView
  length: number
  payload: NodeView[]
  focusEvent: boolean
}

export class Node {
  private expanded: boolean
  private children: Promise<Node[]> | undefined
  private lastTouch = Date.now()
  private defunct = false

  constructor(
    public viewNode: TreeViewNode,
    public level: number,
    private provider: TreeViewProvider,
    private emitter: Emitter<TreeModelUpdate>
  ) {
    this.expanded = false
  }

  public expandable(): boolean {
    return this.viewNode.collapseState !== undefined
  }

  public isExpanded(): boolean {
    return this.expanded
  }

  public async expand(): Promise<boolean> {
    if (this.defunct) return false

    this.provider.sendTreeNodeVisibilityNotification(this.viewNode.nodeUri, false)
    this.expanded = true
    const curState = await this.touch()
    await this.getChildren()
    const visibleNodes = await this.collectVisibleNodes()
    if (curState === this.lastTouch && !this.defunct) {
      this.emitter.fire({root: this.makeView(), length: 1, payload: visibleNodes, focusEvent: false})
      return true
    } else {
      return false
    }
  }

  public async collapse(): Promise<boolean> {
    if (this.defunct) return false

    this.provider.sendTreeNodeVisibilityNotification(this.viewNode.nodeUri, true)
    const curState = await this.touch()
    const height = await this.height()
    this.expanded = false
    if (curState === this.lastTouch && !this.defunct) {
      this.emitter.fire({root: this.makeView(), length: height, payload: [this.makeView()], focusEvent: false})
      return true
    } else {
      return false
    }
  }

  public async refreshSubtree(viewNode: TreeViewNode | undefined): Promise<void> {
    async function findOpenNodes(acc: string[][], curPath: string[], node: Node): Promise<string[][]> {
      if (node.isExpanded()) {
        acc.push(curPath)
        const children = await node.getChildren()
        return children.reduce((zP, child) => {
          return zP.then(z => findOpenNodes(z, curPath.concat(child.viewNode.nodeUri), child))
        }, Promise.resolve(acc))
      } else {
        return acc
      }
    }

    async function reloadSubtree(node: Node, openNodes: string[][]): Promise<void> {
      if (openNodes.length != 0) {
        const children = await node.getChildren()
        const childToNodes = groupBy(openNodes.filter(node => node.length != 0), arr => arr[0])
        await Promise.all(children.map(child => {
          const mbOpenNodes = childToNodes.get(child.viewNode.nodeUri)
          if (mbOpenNodes === undefined) {
            return Promise.resolve()
          } else {
            child.expanded = true
            const nextOpenNodes = mbOpenNodes.map(nodes => nodes.slice(1))
            return reloadSubtree(child, nextOpenNodes)
          }
        }))
      }
    }

    const height = await this.height()
    if (this.isExpanded()) {
      const children = await this.getChildren()
      await Promise.resolve(children.map(child => child.markAsDefunct()))
    }
    const openNodes = await findOpenNodes([], [], this)
    this.children = undefined
    await reloadSubtree(this, openNodes)
    if (viewNode !== undefined) {
      this.viewNode = viewNode
    }
    const visibleNodes = await this.collectVisibleNodes()
    this.emitter.fire({root: this.makeView(), length: height, payload: visibleNodes, focusEvent: false})
  }

  public getChildren(): Promise<Node[]> {
    if (this.children === undefined) {
      const level = this.level
      const promise = Promise.resolve(this.provider.loadNodeChildren(this.viewNode.nodeUri))
        .then(nodes => nodes.map(node => new Node(node, level + 1, this.provider, this.emitter)))
      return this.children = promise
    } else {
      return this.children
    }
  }

  public async height(): Promise<number> {
    if (this.isExpanded()) {
      const children = await this.getChildren()
      const heights = await Promise.all(children.map(child => child.height()))
      return heights.reduce((h1, h2) => h1 + h2, 1)
    } else {
      return 1
    }
  }

  private async collectVisibleNodes(): Promise<NodeView[]> {
    async function collectInternal(acc: NodeView[], node: Node): Promise<NodeView[]> {
      const newAcc = acc.concat(node.makeView())
      if (node.isExpanded()) {
        const children = await node.getChildren()
        return children.reduce((zP, child) => zP.then(z => collectInternal(z, child)), Promise.resolve(newAcc))
      } else {
        return newAcc
      }
    }
    return collectInternal([], this)
  }

  private async touch(): Promise<number> {
    const state = this.lastTouch = Date.now()
    if (this.isExpanded()) {
      const children = await this.getChildren()
      return Promise.all(children.map(child => child.touch())).then(_ => state)
    } else {
      return state
    }
  }

  private async markAsDefunct(): Promise<void> {
    this.defunct = true
    if (this.isExpanded()) {
      const children = await this.getChildren()
      await Promise.all(children.map(child => child.markAsDefunct()))
    }
  }

  public makeView(): NodeView {
    return {
      underlying: this.viewNode,
      level: this.level,
      expandable: this.expandable(),
      expanded: this.isExpanded()
    }
  }
}

export class TreeModel {
  private emitter = new Emitter<TreeModelUpdate>()
  public readonly updateEvents = this.emitter.event
  public readonly rootNode: Node

  constructor(
    public provider: TreeViewProvider,
  ) {
    const viewId = provider.viewId
    const treeViewNode: TreeViewNode = { viewId, label: viewId }
    this.rootNode = new Node(treeViewNode, 0, provider, this.emitter)
    provider.updatedNodes(node => {
      if (node.nodeUri !== undefined) {
        void this.findNodeByUri(node.nodeUri).then(treeNode => {
          if (treeNode !== undefined) return treeNode.refreshSubtree(node)
        })
      } else {
        void this.rootNode.refreshSubtree(undefined)
      }
    })
  }

  public get viewId(): string {
    return this.provider.viewId
  }

  public show(): void {
    return this.provider.sendTreeViewVisibilityNotification(true)
  }

  public hide(): void {
    return this.provider.sendTreeViewVisibilityNotification(false)
  }

  private async findNodeWithOffsetInternal(node: Node, offset: number): Promise<Node | undefined> {
    if (offset == 0) {
      return node
    } else {
      const children = await node.getChildren()
      return children
        .reduce((stateP, child) => {
          return stateP.then(state => {
            if (state.result) {
              return state
            } else {
              return child.height().then(childHeight => {
                if (state.height + childHeight <= offset) {
                  return {height: state.height + childHeight, result: undefined}
                } else {
                  return this.findNodeWithOffsetInternal(child, offset - state.height)
                    .then(result => ({height: 0, result}))
                }
              })
            }
          })
        }, Promise.resolve({height: 1, result: undefined}))
        .then(state => state.result)
    }
  }

  public async findNodeWithOffset(offset: number): Promise<Node | undefined> {
    return this.findNodeWithOffsetInternal(this.rootNode, offset)
  }

  public async findNodeOffset(nodeView: NodeView): Promise<number | undefined> {
    async function findNodeOffsetInternal(acc: [number, boolean], node: Node): Promise<[number, boolean]> {
      if (node.viewNode.nodeUri === nodeView.underlying.nodeUri || acc[1]) {
        return [acc[0], true]
      } else if (node.isExpanded()) {
        const children = await node.getChildren()
        const init: [number, boolean] = [acc[0] + 1, acc[1]]
        return children.reduce((zP, child) => {
          return zP.then(z => findNodeOffsetInternal(z, child))
        }, Promise.resolve(init))
      } else {
        return [acc[0] + 1, acc[1]]
      }
    }
    return findNodeOffsetInternal([0, false], this.rootNode).then(([offset, found]) => {
      return found ? offset : undefined
    })
  }

  public async findParentNode(node: Node): Promise<Node | undefined> {
    async function internal(result: Node | undefined, parent: Node): Promise<Node | undefined> {
      if (result !== undefined) {
        return result
      } else if (parent.isExpanded()) {
        const children = await parent.getChildren()
        return children.reduce((zP, child) => {
          return zP.then(z => {
            if (z !== undefined) {
              return z
            } else if (child.viewNode.nodeUri === node.viewNode.nodeUri) {
              return parent
            } else {
              return internal(undefined, child)
            }
          })
        }, Promise.resolve(undefined))
      } else {
        return undefined
      }
    }
    return internal(undefined, this.rootNode)
  }

  public async revealDocument(textDocument: TextDocument, position: Position): Promise<Node | undefined> {
    const revealResult = await Promise.resolve(this.provider.loadParentInfo(textDocument, position))
    const parents = revealResult.uriChain.reverse()
    const result = await this.revealDocumentInternal(parents, this.rootNode)
    if (result !== undefined) {
      this.emitter.fire({root: result.makeView(), length: 1, payload: [], focusEvent: true})
    }
    return result
  }

  public async revealByParents(parents: string[]): Promise<Node | undefined> {
    return this.revealDocumentInternal(parents, this.rootNode)
  }

  private async revealDocumentInternal(parents: string[], node: Node): Promise<Node | undefined> {
    if (parents.length != 0) {
      const childUri = parents[0]
      const expanded = node.isExpanded() ? true : await node.expand()
      if (expanded) {
        const children = await node.getChildren()
        const child = children.find(child => child.viewNode.nodeUri === childUri)
        if (child) {
          return this.revealDocumentInternal(parents.slice(1), child)
        } else {
          return
        }
      } else {
        return
      }
    } else {
      return node
    }
  }

  private async findNodeByUri(uri: String): Promise<Node | undefined> {
    async function findNodeByUriInternal(acc: Node | undefined, node: Node): Promise<Node | undefined> {
      if (acc !== undefined) {
        return acc
      } else if (node.viewNode.nodeUri === uri) {
        return node
      } else if (node.isExpanded()) {
        const children = await node.getChildren()
        return children.reduce((zP, child) => {
          return zP.then(z => findNodeByUriInternal(z, child))
        }, Promise.resolve(undefined))
      } else {
        return undefined
      }
    }
    return findNodeByUriInternal(undefined, this.rootNode)
  }
}

export class TreeModelManager implements Disposable {

  private treeModels: Map<string, TreeModel> = new Map()
  private ready = false

  public constructor() {
    services.on("ready", _ => {
      this.ready = true
    })
  }

  public register(provider: TreeViewProvider): Disposable {
    const model = new TreeModel(provider)
    this.treeModels.set(provider.viewId, model)

    return Disposable.create(() => {
      this.treeModels.delete(provider.viewId)
    })
  }

  public getViews(): string[] | undefined {
    if (this.ready) {
      return [...this.treeModels.keys()]
    } else {
      return undefined
    }
  }

  public getTreeModel(viewId: string): TreeModel | undefined {
    if (this.ready) {
      return this.treeModels.get(viewId)
    } else {
      return undefined
    }
  }

  public dispose(): void {
    this.treeModels.clear()
  }
}
