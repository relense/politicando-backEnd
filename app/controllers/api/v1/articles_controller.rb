class Api::V1::ArticlesController < ApplicationController
  def index
    articles = Article.all.order(published_time: :desc).first(10)

    result = []

    articles.each do |article|
      result.push(article.attributes.merge!({comments_count: article.comments.present? ? article.comments.size : 0}))
    end

    render json: result, status: 200
  end

  def article_comments
    comments = Article.find(params["article_id"].to_i).comments
    organized = organize_comments(comments)

    render json: organized, status: 200
  end  

  def show
    article = Article.find(params[:id])
    article = article.attributes.merge({comments_count: article.comments.present? ? article.comments.size : 0})

    render json: article, include: :comments, status: 200
  end

  def get_ten
    articles = Article.all.order(published_time: :desc)

    last_article_index = articles.index { |h| h[:id] == params["article_id"].to_i}
    new_articles = articles[(last_article_index + 1)..(last_article_index + 10)]

    result = []

    new_articles.each do |article|
      result.push(article.attributes.merge!({comments_count: article.comments.present? ? article.comments.size : 0}))
    end

    render json: result, status: 200
  end


  private

  def organize_comments(comments)
    organized_comments_list = []

    comments.each do |comment|
      comment_hash = comment.as_json

      if comment.comments_id.present?
        comment_hash.merge!({parent_username: Comment.find(comment.comments_id).username})
      else
        comment_hash.merge!({parent_username: nil})
      end

      organized_comments_list.push(comment_hash);
    end

    return organized_comments_list
  end
end
